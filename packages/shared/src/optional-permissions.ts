import { z } from "zod";

export const OptionalCapabilityPermissionSchema = z.enum([
  "bookmarks",
  "history",
  "downloads",
  "notifications",
]);

export type OptionalCapabilityPermission = z.infer<
  typeof OptionalCapabilityPermissionSchema
>;

export const PermissionCapabilitySchema = z.enum([
  "searchBookmarks",
  "bookmarkMention",
  "searchHistory",
  "downloadImage",
  "downloadSpreadsheet",
  "jobNotifications",
]);

export type PermissionCapability = z.infer<typeof PermissionCapabilitySchema>;

export const PermissionRequiredSchema = z.object({
  code: z.literal("permission_required"),
  permission: OptionalCapabilityPermissionSchema,
  capability: PermissionCapabilitySchema,
  requestable: z.literal(true),
});

export type PermissionRequired = z.infer<typeof PermissionRequiredSchema>;

const PREFIX = "AIPAGEGO_PERMISSION_REQUIRED:";

/**
 * Error form used inside the extension. The prefixed JSON message survives
 * chrome.runtime and coordinator boundaries that otherwise keep only a
 * string, while `details` stays ergonomic for same-context callers.
 */
export class PermissionRequiredError extends Error {
  readonly details: PermissionRequired;

  constructor(required: PermissionRequired) {
    const details = PermissionRequiredSchema.parse(required);
    super(`${PREFIX}${JSON.stringify(details)}`);
    this.name = "PermissionRequiredError";
    this.details = details;
  }
}

export function parsePermissionRequired(value: unknown): PermissionRequired | null {
  if (value instanceof PermissionRequiredError) return value.details;
  const message = value instanceof Error ? value.message : value;
  if (typeof message !== "string" || !message.startsWith(PREFIX)) return null;
  try {
    const parsed = PermissionRequiredSchema.safeParse(
      JSON.parse(message.slice(PREFIX.length)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
