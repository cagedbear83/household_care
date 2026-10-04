import type { TaskFrequency } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import type { Actor } from "./schedule.service";

export class TemplateRejectedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface TemplateFields {
  groupName: string;
  title: string;
  instructions: string;
  frequency: TaskFrequency;
  requiresPhoto: boolean;
  sortOrder: number;
}

export async function createTemplate(actor: Actor, fields: TemplateFields) {
  return db.$transaction(async (tx) => {
    const template = await tx.taskTemplate.create({ data: { householdId: actor.householdId, ...fields } });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "task_template_created",
      payload: { templateId: template.id, after: fields },
    });
    return template;
  });
}

/** Past TaskInstances keep their own snapshot of the title/instructions, so
 * editing a template never rewrites historical work; the before/after pair
 * is recorded in the event log for the audit trail. */
export async function updateTemplate(
  actor: Actor,
  templateId: string,
  changes: Partial<TemplateFields> & { active?: boolean }
) {
  return db.$transaction(async (tx) => {
    const before = await tx.taskTemplate.findFirst({ where: { id: templateId, householdId: actor.householdId } });
    if (!before) throw new TemplateRejectedError("NOT_FOUND", "Template not found.");

    const after = await tx.taskTemplate.update({ where: { id: templateId }, data: changes });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "task_template_updated",
      payload: { templateId, changes, before },
    });
    return after;
  });
}
