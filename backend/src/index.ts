import express from "express";
import cors from "cors";
import cron from "node-cron";
import { env } from "./env";
import { authRouter } from "./routes/auth.routes";
import { shiftsRouter } from "./routes/shifts.routes";
import { tasksRouter } from "./routes/tasks.routes";
import { adminRouter } from "./routes/admin.routes";
import { evidenceRouter } from "./routes/evidence.routes";
import { reviewRouter } from "./routes/review.routes";
import { meRouter } from "./routes/me.routes";
import { familyRouter } from "./routes/family.routes";
import { invitesRouter } from "./routes/invites.routes";
import { chatRouter } from "./routes/chat.routes";
import { devRouter } from "./routes/dev.routes";
import { foodRouter } from "./routes/food.routes";
import { shoppingRouter } from "./routes/shopping.routes";
import { alertsRouter } from "./routes/alerts.routes";
import { summariesRouter } from "./routes/summaries.routes";
import { reportsRouter } from "./routes/reports.routes";
import { correctionsRouter } from "./routes/corrections.routes";
import { awayRouter } from "./routes/away.routes";
import { preservationsRouter } from "./routes/preservations.routes";
import { checkinsRouter } from "./routes/checkins.routes";
import { removeExpiredPhotos } from "./services/photo-retention";
import { sendPayPeriodReminders, sendWeeklyHoursNotices } from "./services/scheduled-notices.service";
import { deliverPendingAlerts } from "./services/alert-feed.service";
import { closeExpiredAuthorizations } from "./services/authorization.service";
import { escalateStaleFoodRequests } from "./services/food.service";

const app = express();
app.use(cors());
// Photo uploads arrive as base64 JSON; allow a larger body for just those routes.
// Registered first so the global parser below (default limit) skips them.
app.use("/tasks/:id/evidence", express.json({ limit: "12mb" }));
// Food requests carry a photo too (exact paths only, so the small decision endpoints keep the default limit).
app.post(["/food/requests", "/food/hazards"], express.json({ limit: "12mb" }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth", authRouter);
app.use("/shifts", shiftsRouter);
app.use("/tasks", tasksRouter);
app.use("/admin", adminRouter);
app.use("/evidence", evidenceRouter);
app.use("/review", reviewRouter);
app.use("/me", meRouter);
app.use("/family", familyRouter);
app.use("/invites", invitesRouter);
app.use("/chat", chatRouter);
app.use("/food", foodRouter);
app.use("/shopping", shoppingRouter);
app.use("/alerts", alertsRouter);
app.use("/summaries", summariesRouter);
app.use("/reports", reportsRouter);
app.use("/corrections", correctionsRouter);
app.use("/away", awayRouter);
app.use("/preservations", preservationsRouter);
app.use("/checkins", checkinsRouter);
if (process.env.NODE_ENV !== "production") app.use("/dev", devRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Body-parser failures (too large, malformed JSON) carry a 4xx status; pass
  // that through instead of reporting them as server errors.
  const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return res.status(status).json({
      error: status === 413 ? "That upload is too large." : "The request could not be read.",
      code: status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
    });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`household-care backend listening on :${env.PORT}`);
});

// Enforces the scheduled-end / 36-hour-cap boundary server-side even if the
// IP's phone is asleep or offline. Every minute is frequent enough that the
// spec's "immediate" alert expectation is met without hammering the DB.
cron.schedule("* * * * *", () => {
  closeExpiredAuthorizations().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("closeExpiredAuthorizations failed", err);
  });
  // A food request nobody answered stays put; administrators get one alert.
  escalateStaleFoodRequests().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("escalateStaleFoodRequests failed", err);
  });
  // Weekly hours for the IP and the pay-period reminder: each is sent once when its time comes.
  sendWeeklyHoursNotices().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("sendWeeklyHoursNotices failed", err);
  });
  sendPayPeriodReminders().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("sendPayPeriodReminders failed", err);
  });
  // Text/email the people an alert is for (retried up to 3 times, each sent once).
  deliverPendingAlerts().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("deliverPendingAlerts failed", err);
  });
});

// Once a day, shortly after 3 a.m.: remove photos that are a year old (never ones tied to a dispute or inside a preservation).
cron.schedule("17 3 * * *", () => {
  removeExpiredPhotos().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("removeExpiredPhotos failed", err);
  });
});
