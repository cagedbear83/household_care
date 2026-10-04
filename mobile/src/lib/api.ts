import { Platform } from "react-native";

// On a physical device, "localhost" means the device itself, not your dev
// machine — there EXPO_PUBLIC_API_URL must be set to your machine's LAN IP
// (e.g. http://192.168.1.50:4000). The Android emulator and web/iOS
// simulator each need a different default, so pick one automatically unless
// EXPO_PUBLIC_API_URL overrides it.
function defaultApiUrl(): string {
  if (Platform.OS === "android") return "http://10.0.2.2:4000";
  return "http://localhost:4000"; // web, iOS simulator
}

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? defaultApiUrl();

export class ApiError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) {
    super(message);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  token?: string | null;
  body?: unknown;
}

let onUnauthorized: (() => void) | null = null;

/** Registered by the auth provider: called when the server rejects a saved login. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;

  if (response.status === 401 && options.token) onUnauthorized?.();

  if (!response.ok) {
    throw new ApiError(response.status, data?.code, data?.error ?? "Request failed");
  }
  return data as T;
}

export type Role = "ADMIN" | "CLIENT" | "IP" | "FAMILY";

export interface LoginResponse {
  token: string;
  user: { id: string; name: string; role: "ADMIN" | "CLIENT" | "IP" | "FAMILY"; householdId: string };
}

/** Sign in with an email address or a phone number. */
export function login(identifier: string, password: string) {
  return request<LoginResponse>("/auth/login", { method: "POST", body: { identifier, password } });
}

/** Always answers the same way; with no real provider (development), the code is handed back so it can be tried. */
export function requestPasswordReset(identifier: string) {
  return request<{ ok: true; message: string; devCode?: string }>("/auth/forgot", { method: "POST", body: { identifier } });
}

export function resetPassword(identifier: string, code: string, newPassword: string) {
  return request<{ ok: true }>("/auth/reset", { method: "POST", body: { identifier, code, newPassword } });
}

export interface MeResponse {
  user: { id: string; name: string; role: LoginResponse["user"]["role"]; email: string | null; phone: string | null; canViewTimestamps: boolean };
  household: { timezone: string; /** 0 = Sunday .. 6 = Saturday */ workweekStartWeekday: number };
}

export function getMe(token: string) {
  return request<MeResponse>("/me", { token });
}

export interface TaskInstanceDto {
  id: string;
  titleSnapshot: string;
  instructionsSnapshot: string;
  requiresPhotoSnapshot: boolean;
  state: string;
  reasonCode: string | null;
  reasonText: string | null;
  /** True once the server has accepted a photo that counts for this task (no timestamps are shared with the IP). */
  hasEvidence: boolean;
  /** The client's message about this task: why it was disputed, or why a reported decline was not accepted. */
  clientNote: string | null;
  /** The IP's latest "report completion error" on this task, if any. */
  correctionStatus: "OPEN" | "RESOLVED" | "DECLINED" | null;
}

export interface ShiftDto {
  id: string;
  localDate: string;
  scheduledStartUtc: string;
  scheduledEndUtc: string;
  status: string;
  checkInEventId: string | null;
  checkOutEventId: string | null;
  observedCheckInUtc: string | null;
  observedCheckOutUtc: string | null;
  authorizedEndUtc: string | null;
  authorizationClosedAt: string | null;
  taskInstances: TaskInstanceDto[];
}

export function getTodayShift(token: string) {
  return request<{ shift: ShiftDto | null; message?: string }>("/shifts/today", { token });
}

export interface Coords {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
}

export function checkIn(token: string, shiftId: string, coords: Coords) {
  return request<{ shift: ShiftDto }>(`/shifts/${shiftId}/check-in`, { method: "POST", token, body: coords });
}

export function checkOut(token: string, shiftId: string, coords: Coords | null) {
  return request<{ shift: ShiftDto }>(`/shifts/${shiftId}/check-out`, {
    method: "POST",
    token,
    body: coords ?? { lat: null, lng: null, accuracyMeters: null },
  });
}

export function locationPing(token: string, shiftId: string, coords: Coords) {
  return request<{ reading: unknown }>(`/shifts/${shiftId}/location-ping`, { method: "POST", token, body: coords });
}

export function completeTask(token: string, taskId: string) {
  return request<{ task: TaskInstanceDto }>(`/tasks/${taskId}/complete`, { method: "POST", token, body: {} });
}

/** Called when the in-app camera opens; the upload must present this one-use ticket. */
export function requestEvidenceChallenge(token: string, taskId: string) {
  return request<{ challengeId: string; expiresAt: string }>(`/tasks/${taskId}/evidence/challenge`, {
    method: "POST",
    token,
    body: {},
  });
}

export function uploadEvidence(
  token: string,
  taskId: string,
  body: {
    challengeId: string;
    imageBase64: string;
    capturedAtDevice: string;
    lat: number | null;
    lng: number | null;
    accuracyMeters: number | null;
  }
) {
  return request<{ task: TaskInstanceDto }>(`/tasks/${taskId}/evidence`, { method: "POST", token, body });
}

export function markTaskException(
  token: string,
  taskId: string,
  outcome: "NOT_NEEDED" | "UNABLE_TO_COMPLETE",
  reasonCode: "supplies_unavailable" | "insufficient_time" | "equipment_problem" | "other",
  reasonText?: string
) {
  return request<{ task: TaskInstanceDto }>(`/tasks/${taskId}/exception`, {
    method: "POST",
    token,
    body: { outcome, reasonCode, reasonText },
  });
}

export type ShiftStatus = "SCHEDULED" | "VACATION" | "SICK" | "CLIENT_UNAVAILABLE" | "NOT_SCHEDULED";

export interface ScheduleContext {
  household: { timezone: string; weeklyHourCapMinutes: number; workweekStartWeekday: number };
  ips: { id: string; name: string }[];
}

export interface AdminShift {
  id: string;
  ipUserId: string;
  localDate: string;
  scheduledStartUtc: string;
  scheduledEndUtc: string;
  status: ShiftStatus;
  recurringSourceId: string | null;
  checkInEventId: string | null;
  checkOutEventId: string | null;
  previous: { id: string; localDate: string; status: ShiftStatus; scheduledStartUtc: string; scheduledEndUtc: string } | null;
}

export interface GenerationResult {
  localDate: string;
  ipUserId: string;
  outcome: "created" | "skipped";
  code?: string;
  message?: string;
}

export function getScheduleContext(token: string) {
  return request<ScheduleContext>("/admin/schedule-context", { token });
}

export function listShifts(token: string, from: string, to: string) {
  return request<{ shifts: AdminShift[] }>(`/admin/shifts?from=${from}&to=${to}`, { token });
}

export function createShift(
  token: string,
  body: { ipUserId: string; localDate: string; status: ShiftStatus; startLocal?: string; endLocal?: string }
) {
  return request<{ shift: AdminShift }>("/admin/shifts", { method: "POST", token, body });
}

export function replaceShift(
  token: string,
  shiftId: string,
  body: { localDate: string; status: ShiftStatus; startLocal?: string; endLocal?: string; reason: string }
) {
  return request<{ shift: AdminShift }>(`/admin/shifts/${shiftId}`, { method: "PUT", token, body });
}

export function cancelShift(token: string, shiftId: string, reason: string) {
  return request<{ shift: AdminShift }>(`/admin/shifts/${shiftId}/cancel`, { method: "POST", token, body: { reason } });
}

export function createRecurringRule(
  token: string,
  body: { ipUserId: string; weekday: number; startLocal: string; endLocal: string; effectiveFrom: string }
) {
  return request<{ rule: { id: string } }>("/admin/recurring-rules", { method: "POST", token, body });
}

export function generateSchedule(token: string, from: string, to: string) {
  return request<{ results: GenerationResult[] }>("/admin/schedule/generate", {
    method: "POST",
    token,
    body: { from, to },
  });
}

export interface ReviewEvidence {
  id: string;
  uploadAcceptedAtServer: string;
  contentHashShort: string;
  byteSize: number;
  locationVerification: "VERIFIED" | "UNVERIFIED" | "FAILED" | null;
}

export interface ReviewComment {
  id: string;
  /** Set when the comment is about one photo; null for a comment on the task. */
  evidenceId: string | null;
  authorName: string;
  authorRoleLabel: string;
  body: string;
  /** Null for family members who have not been approved to see times. */
  at: string | null;
}

export interface ReviewHistoryItem {
  /** Only the client and administrators get this: it is what a correction links to. */
  eventId: string | null;
  action: string;
  /** Null for family members who have not been approved to see times. */
  at: string | null;
  actorRole: string;
  actorName: string | null;
  detail: string | null;
}

export interface ReviewTask {
  id: string;
  title: string;
  instructions: string;
  groupName: string;
  state: string;
  requiresPhoto: boolean;
  reasonCode: string | null;
  reasonText: string | null;
  clientNote: string | null;
  shiftLocalDate: string;
  ipName: string;
  /** How many photos exist. The photos themselves (evidence) are empty for family without approval. */
  photoCount: number;
  evidence: ReviewEvidence[];
  history: ReviewHistoryItem[];
  comments: ReviewComment[];
}

export interface ReviewShift {
  id: string;
  ipName: string;
  status: ShiftStatus;
  scheduledStartUtc: string;
  scheduledEndUtc: string;
  observedCheckInUtc: string | null;
  observedCheckOutUtc: string | null;
  checkedIn: boolean;
  checkedOut: boolean;
  checkInEventId: string | null;
  checkOutEventId: string | null;
  tasks: ReviewTask[];
}

export function getReviewDay(token: string, date: string) {
  return request<{ shifts: ReviewShift[] }>(`/review/day?date=${date}`, { token });
}

export function getReviewPending(token: string) {
  return request<{ tasks: ReviewTask[] }>("/review/pending", { token });
}

const decide = (token: string, taskId: string, action: string, body: unknown = {}) =>
  request<{ task: ReviewTask }>(`/review/tasks/${taskId}/${action}`, { method: "POST", token, body });

export const approveTask = (token: string, taskId: string) => decide(token, taskId, "approve");
export const disputeTask = (token: string, taskId: string, reason: string) => decide(token, taskId, "dispute", { reason });
export const confirmDecline = (token: string, taskId: string) => decide(token, taskId, "confirm-decline");
export const denyDecline = (token: string, taskId: string, note?: string) => decide(token, taskId, "deny-decline", { note });

/** Comment on a task (complete or not), or on one of its photos. Returns the refreshed task. */
export function addComment(token: string, taskId: string, body: string, evidenceId?: string) {
  return request<{ task: ReviewTask }>(`/review/tasks/${taskId}/comments`, { method: "POST", token, body: { body, evidenceId: evidenceId ?? null } });
}

// --- Family access (client and administrators) ---

export type FamilyStatus = "INVITED" | "EXPIRED" | "NEEDS_SECOND_CONTACT" | "ACTIVE" | "REVOKED";

export interface FamilyEntry {
  id: string;
  name: string;
  relationship: string | null;
  status: FamilyStatus;
  invitedVia: "EMAIL" | "SMS";
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  canViewTimestamps: boolean;
  invitedBy: string | null;
}

export interface Delivery {
  delivered: boolean;
  provider: string;
  /** Development only: the link that would have been sent, since nothing is really emailed or texted. */
  devLink?: string;
}

export function getFamily(token: string) {
  return request<{ family: FamilyEntry[] }>("/family", { token });
}

export function inviteFamily(
  token: string,
  body: { firstName: string; lastName: string; email?: string; phone?: string; relationship?: string; canViewTimestamps?: boolean }
) {
  return request<{ id: string; delivery: Delivery }>("/family/invites", { method: "POST", token, body });
}

export const resendFamilyInvite = (token: string, id: string) =>
  request<{ id: string; delivery: Delivery }>(`/family/${id}/resend`, { method: "POST", token, body: {} });

export const revokeFamily = (token: string, id: string) => request<{ ok: true }>(`/family/${id}/revoke`, { method: "POST", token, body: {} });

export const setFamilyVisibility = (token: string, id: string, canViewTimestamps: boolean) =>
  request<{ ok: true }>(`/family/${id}`, { method: "PATCH", token, body: { canViewTimestamps } });

// --- The family member's signup (public: the link's token is the credential) ---

export interface InviteInfo {
  stage: "PENDING" | "ACCEPTED";
  inviterName: string;
  invitedVia: "EMAIL" | "SMS";
  contactMasked: string;
  firstName: string;
  lastName: string;
  otherChannel: "EMAIL" | "SMS";
  pendingContactMasked: string | null;
}

export const getInvite = (token: string) => request<InviteInfo>(`/invites/${encodeURIComponent(token)}`);

export const acceptInvite = (token: string, body: { firstName: string; lastName: string; password: string; confirmContact: boolean }) =>
  request<{ stage: "ACCEPTED"; otherChannel: "EMAIL" | "SMS" }>(`/invites/${encodeURIComponent(token)}/accept`, { method: "POST", body });

export const startOtherContact = (token: string, value: string) =>
  request<{ sent: boolean; sentToMasked: string; devCode?: string }>(`/invites/${encodeURIComponent(token)}/other-contact`, { method: "POST", body: { value } });

export const verifyOtherContact = (token: string, code: string) =>
  request<LoginResponse>(`/invites/${encodeURIComponent(token)}/verify`, { method: "POST", body: { code } });

// --- Chat ---

export interface ChatPerson {
  id: string;
  name: string;
  roleLabel: string;
}

export interface ConversationSummary {
  id: string;
  kind: "GROUP" | "DIRECT";
  title: string;
  subtitle: string | null;
  canSend: boolean;
  unread: number;
  lastMessage: { body: string; senderName: string; at: string } | null;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderRoleLabel: string;
  body: string;
  at: string;
  mine: boolean;
}

export const getChatPeople = (token: string) => request<{ people: ChatPerson[] }>("/chat/people", { token });
export const getConversations = (token: string) => request<{ conversations: ConversationSummary[] }>("/chat/conversations", { token });
export const getUnread = (token: string) => request<{ unread: number }>("/chat/unread", { token });
export const startDirect = (token: string, userId: string) => request<{ id: string }>("/chat/direct", { method: "POST", token, body: { userId } });
export const getMessages = (token: string, conversationId: string, afterId?: string) =>
  request<{ messages: ChatMessage[] }>(`/chat/conversations/${conversationId}/messages${afterId ? `?afterId=${afterId}` : ""}`, { token });
export const sendChatMessage = (token: string, conversationId: string, body: string) =>
  request<{ id: string }>(`/chat/conversations/${conversationId}/messages`, { method: "POST", token, body: { body } });
export const markConversationRead = (token: string, conversationId: string) =>
  request<{ ok: true }>(`/chat/conversations/${conversationId}/read`, { method: "POST", token, body: {} });

// --- Food disposal ---

export type FoodStatus = "PENDING" | "APPROVED" | "DECLINED" | "DISPOSED" | "HAZARD_REPORTED" | "HAZARD_ACKNOWLEDGED";

export const FOOD_REASONS: { code: string; label: string }[] = [
  { code: "past_date", label: "Past the date on the label" },
  { code: "spoiled", label: "Spoiled" },
  { code: "moldy", label: "Moldy" },
  { code: "smells_bad", label: "Smells bad" },
  { code: "other", label: "Other" },
];

/** What the client and administrators see: the whole record, with who did what and when. */
export interface FoodStaffRequest {
  id: string;
  kind: "DISPOSAL" | "HAZARD";
  status: FoodStatus;
  item: string;
  location: string;
  reason: string;
  reasonText: string | null;
  dateLabel: string | null;
  replacement: string | null;
  actionTaken: string | null;
  requestedBy: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  disposedBy: string | null;
  disposedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  escalatedAt: string | null;
  hasPhoto: boolean;
  photoLocationVerification: "VERIFIED" | "UNVERIFIED" | "FAILED" | null;
  photoFingerprint: string | null;
}

/** What the IP sees of their own requests: status and the client's answer, no audit timestamps. */
export interface FoodIpRequest {
  id: string;
  kind: "DISPOSAL" | "HAZARD";
  status: FoodStatus;
  item: string;
  location: string;
  reason: string;
  dateLabel: string | null;
  replacement: string | null;
  decisionNote: string | null;
  leaveInPlace: boolean;
}

export interface FoodPhotoPayload {
  challengeId: string;
  imageBase64: string;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
}

export const getFoodRequests = (token: string) =>
  request<{ pending: FoodStaffRequest[]; hazards: FoodStaffRequest[]; approvedWaiting: FoodStaffRequest[]; history: FoodStaffRequest[] }>("/food/requests", { token });
export const approveFood = (token: string, id: string) => request<{ ok: true }>(`/food/requests/${id}/approve`, { method: "POST", token, body: {} });
export const declineFood = (token: string, id: string, note?: string) => request<{ ok: true }>(`/food/requests/${id}/decline`, { method: "POST", token, body: { note } });
export const acknowledgeFoodHazard = (token: string, id: string) => request<{ ok: true }>(`/food/requests/${id}/acknowledge`, { method: "POST", token, body: {} });
export const foodPhotoUrl = (id: string) => `${API_URL}/food/requests/${id}/photo`;

export const requestFoodChallenge = (token: string) => request<{ challengeId: string; expiresAt: string }>("/food/photo-challenge", { method: "POST", token, body: {} });
export const createFoodRequest = (
  token: string,
  body: { item: string; location: string; reasonCode: string; reasonText?: string; dateLabel?: string; replacement?: string } & FoodPhotoPayload
) => request<{ id: string }>("/food/requests", { method: "POST", token, body });
export const reportFoodHazard = (
  token: string,
  body: { item: string; location: string; reason: string; actionTaken: string; replacement?: string; photo?: FoodPhotoPayload }
) => request<{ id: string }>("/food/hazards", { method: "POST", token, body });
export const recordFoodDisposal = (token: string, id: string) => request<{ ok: true }>(`/food/requests/${id}/dispose`, { method: "POST", token, body: {} });
export const getMyFoodRequests = (token: string) => request<{ requests: FoodIpRequest[] }>("/food/mine", { token });

// --- Shopping list ---

export type ShoppingStatus = "NEEDED" | "LOW" | "OUT" | "PURCHASED" | "DISMISSED";

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: string | null;
  storageLocation: string | null;
  status: ShoppingStatus;
  source: "CLIENT" | "ADMIN" | "IP_REPORT" | "DISPOSAL";
  note: string | null;
  reportCount: number;
  addedBy: string | null;
  addedAt: string;
  closedBy: string | null;
  closedAt: string | null;
}

export const getShopping = (token: string) => request<{ open: ShoppingItem[]; recent: ShoppingItem[] }>("/shopping", { token });
export const addShoppingItem = (token: string, body: { name: string; quantity?: string; storageLocation?: string; status?: "NEEDED" | "LOW" | "OUT"; note?: string }) =>
  request<{ id: string; merged: boolean }>("/shopping", { method: "POST", token, body });
export const updateShoppingItem = (token: string, id: string, body: { quantity?: string | null; storageLocation?: string | null; status?: "NEEDED" | "LOW" | "OUT"; note?: string | null }) =>
  request<{ ok: true }>(`/shopping/${id}`, { method: "PATCH", token, body });
export const markShoppingPurchased = (token: string, id: string) => request<{ ok: true }>(`/shopping/${id}/purchased`, { method: "POST", token, body: {} });
export const dismissShoppingItem = (token: string, id: string) => request<{ ok: true }>(`/shopping/${id}/dismiss`, { method: "POST", token, body: {} });
export const reportLowSupply = (token: string, body: { item: string; level: "LOW" | "OUT"; location?: string; note?: string }) =>
  request<{ ok: true; added: boolean; status: ShoppingStatus }>("/shopping/low", { method: "POST", token, body });

/** The IP submits corrected work after a dispute (while the shift is open). */
export function submitCorrective(token: string, taskId: string) {
  return request<{ task: TaskInstanceDto }>(`/tasks/${taskId}/corrective`, { method: "POST", token, body: {} });
}

/** Where a submitted photo's viewer copy (metadata stripped) is served from; needs the bearer token. */
export const evidenceImageUrl = (evidenceId: string) => `${API_URL}/evidence/${evidenceId}/image`;

export type TaskFrequency = "VISIT" | "WEEKLY" | "MONTHLY" | "AS_NEEDED";

export interface TemplateDto {
  id: string;
  groupName: string;
  title: string;
  instructions: string;
  frequency: TaskFrequency;
  requiresPhoto: boolean;
  sortOrder: number;
  active: boolean;
}

export type TemplateFields = Omit<TemplateDto, "id" | "active">;

export function listTemplates(token: string) {
  return request<{ templates: TemplateDto[] }>("/admin/task-templates", { token });
}

export function createTemplate(token: string, body: TemplateFields) {
  return request<{ template: TemplateDto }>("/admin/task-templates", { method: "POST", token, body });
}

export function updateTemplate(token: string, id: string, body: Partial<TemplateFields> & { active?: boolean }) {
  return request<{ template: TemplateDto }>(`/admin/task-templates/${id}`, { method: "PATCH", token, body });
}

export function declineTask(token: string, taskId: string, note?: string) {
  return request<{ task: TaskInstanceDto }>(`/tasks/${taskId}/decline`, { method: "POST", token, body: { note } });
}

// --- Alerts and spoken summaries ---------------------------------------------------

export type AlertSeverity = "URGENT" | "NORMAL" | "INFO";

export interface AlertDto {
  id: string;
  type: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  link: string | null;
  createdAt: string;
  read: boolean;
  resolved: boolean;
}

export interface AlertsUnread {
  unread: number;
  urgent: number;
  newestUrgent: { id: string; title: string; message: string } | null;
}

export const getAlerts = (token: string) => request<{ alerts: AlertDto[] }>("/alerts", { token });
export const getAlertsUnread = (token: string) => request<AlertsUnread>("/alerts/unread", { token });
export const markAlertRead = (token: string, id: string) => request<{ ok: true }>(`/alerts/${id}/read`, { method: "POST", token, body: {} });
export const markAllAlertsRead = (token: string) => request<{ marked: number }>("/alerts/read-all", { method: "POST", token, body: {} });

export type SummaryId = "briefing" | "decisions" | "completed" | "left" | "checkin" | "hours" | "shopping" | "alerts" | "messages";

export interface SummaryDto {
  id: SummaryId;
  title: string;
  text: string;
  empty: boolean;
  askFirst?: string;
}

export const getSummaries = (token: string) => request<{ summaries: SummaryDto[] }>("/summaries", { token });

// --- Settings ---------------------------------------------------------------------

export interface Profile {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  role: Role;
  roleLabel: string;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  relationship: string | null;
  canViewTimestamps: boolean | null;
  household: { name: string; timezone: string };
}

export const getProfile = (token: string) => request<{ profile: Profile }>("/me/profile", { token });
export const updateProfileName = (token: string, firstName: string, lastName: string) =>
  request<{ profile: Profile }>("/me/profile", { method: "PATCH", token, body: { firstName, lastName } });
export const changeMyPassword = (token: string, currentPassword: string, newPassword: string) =>
  request<{ token: string }>("/me/password", { method: "POST", token, body: { currentPassword, newPassword } });
export const startContactChange = (token: string, value: string) =>
  request<{ channel: "EMAIL" | "SMS"; maskedTo: string; devCode?: string }>("/me/contact/start", { method: "POST", token, body: { value } });
export const confirmContactChange = (token: string, code: string) =>
  request<{ profile: Profile }>("/me/contact/confirm", { method: "POST", token, body: { code } });

// --- Reports ----------------------------------------------------------------------

export interface TaskCounts {
  assigned: number;
  submitted: number;
  approved: number;
  awaitingReview: number;
  disputed: number;
  correctiveSubmitted: number;
  declineAwaitingConfirmation: number;
  confirmedDeclined: number;
  notNeeded: number;
  unableToComplete: number;
  missed: number;
  stillOpen: number;
  correctedErrors: number;
}

export interface ReportAttendanceRow {
  shiftId: string;
  date: string;
  ipName: string;
  scheduledStart: string;
  scheduledEnd: string;
  scheduledMinutes: number;
  status: "attended" | "in_progress" | "missed" | "no_checkout" | "upcoming";
  checkIn: string | null;
  checkOut: string | null;
  observedMinutes: number | null;
  authorizedMinutes: number;
  tasks: TaskCounts;
  correctionNotes: string[];
}

export interface Report {
  meta: {
    generatedAt: string;
    from: string;
    to: string;
    days: number;
    timezone: string;
    generatedBy: { name: string; role: Role };
    scope: "full" | "tasks_only";
    weeklyLimitMinutes: number;
    notes: string[];
  };
  tasks: {
    totals: TaskCounts;
    percentages: { completion: number | null; approved: number | null; coverage: number | null; resolution: number | null };
    resolved: number;
    unresolved: number;
    byDay: (TaskCounts & { date: string })[];
    byGroup: (TaskCounts & { group: string })[];
    notCompleted: { date: string; group: string; title: string; outcome: string; reason: string | null }[];
    notCompletedTotal: number;
  };
  attendance: null | {
    rows: ReportAttendanceRow[];
    totals: Record<string, number>;
    weeks: { weekStart: string; weekEnd: string; authorizedMinutes: number; observedMinutes: number; capMinutes: number; overCap: boolean; partial: boolean }[];
    daysOff: { date: string; ipName: string; status: string }[];
  };
  exceptions: null | {
    items: { date: string; at: string | null; kind: string; label: string; text: string }[];
    counts: Record<string, number>;
    adminCorrections: number;
  };
}

export const getReport = (token: string, from: string, to: string) => request<Report>(`/reports?from=${from}&to=${to}`, { token });

// --- Corrections --------------------------------------------------------------------

export type CorrectionKind = "COMPLETION_ERROR" | "ATTENDANCE" | "NOTE";

export interface MyCorrectionRequest {
  id: string;
  about: string;
  reason: string;
  status: "OPEN" | "RESOLVED" | "DECLINED";
  /** The answer: the correction's reason, or why it was not corrected. */
  answer: string | null;
}

export interface OpenCorrectionRequest {
  id: string;
  requestedBy: string;
  about: string;
  isTask: boolean;
  reason: string;
  linkedEventId: string;
  linkedAction: string | null;
  taskState: string | null;
  requestedAt: string;
}

export interface CorrectionRecord {
  id: string;
  kind: CorrectionKind;
  about: string;
  reason: string;
  by: string;
  byRole: Role;
  linkedAction: string | null;
  linkedAt: string | null;
  answeredRequest: boolean;
  createdAt: string;
}

export interface CorrectionsList {
  open: OpenCorrectionRequest[];
  declined: { id: string; requestedBy: string; about: string; reason: string; declineReason: string | null; decidedBy: string | null; decidedAt: string | null }[];
  corrections: CorrectionRecord[];
}

export const getCorrections = (token: string) => request<CorrectionsList>("/corrections", { token });
export const appendCorrection = (token: string, body: { kind: CorrectionKind; linkedEventId: string; reason: string; requestId?: string }) =>
  request<{ id: string }>("/corrections", { method: "POST", token, body });
export const declineCorrectionRequest = (token: string, id: string, reason: string) =>
  request<{ ok: true }>(`/corrections/requests/${id}/decline`, { method: "POST", token, body: { reason } });
export const reportCompletionError = (token: string, body: { taskInstanceId?: string; shiftId?: string; reason: string }) =>
  request<{ id: string; status: string }>("/corrections/report", { method: "POST", token, body });
export const getMyCorrections = (token: string) => request<{ requests: MyCorrectionRequest[] }>("/corrections/mine", { token });

// --- Retention ----------------------------------------------------------------------

export interface RetentionStatus {
  now: string;
  timezone: string;
  policy: {
    days: number;
    confirmed: boolean;
    recommendedDays: number;
    minDays: number;
    maxDays: number;
    setBy: string | null;
    setAt: string | null;
    reducedFrom: number | null;
  };
  history: { retentionDays: number; effectiveFrom: string | null; setBy: string | null; reason: string | null; isDefault: boolean }[];
  holds: {
    id: string;
    reason: string;
    fromDate: string | null;
    toDate: string | null;
    placedBy: string | null;
    placedAt: string;
    active: boolean;
    releasedBy: string | null;
    releasedAt: string | null;
    releaseReason: string | null;
  }[];
  records: {
    events: number;
    photos: number;
    oldestRecordedAt: string | null;
    earliestExpiry: string | null;
    pastRetention: { events: number; photos: number };
    reviewable: { events: number; photos: number };
    heldBack: { events: number; photos: number };
    unresolvedDisputes: number;
  };
  notes: string[];
}

export const getRetention = (token: string) => request<RetentionStatus>("/retention", { token });
export const setRetentionPeriod = (token: string, body: { days: number; reason?: string; password: string }) =>
  request<RetentionStatus>("/retention/policy", { method: "POST", token, body });
export const placeRetentionHold = (token: string, body: { reason: string; fromDate?: string; toDate?: string; password: string }) =>
  request<RetentionStatus>("/retention/holds", { method: "POST", token, body });
export const releaseRetentionHold = (token: string, id: string, body: { reason: string; password: string }) =>
  request<RetentionStatus>(`/retention/holds/${id}/release`, { method: "POST", token, body });
