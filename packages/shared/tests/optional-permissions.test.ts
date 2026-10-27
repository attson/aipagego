import { describe, expect, it } from "vitest";

import {
  PermissionRequiredError,
  PermissionRequiredSchema,
  parsePermissionRequired,
} from "../src/optional-permissions";

describe("optional permission contract", () => {
  it("round-trips a machine-readable bookmark permission error through Error.message", () => {
    const required = {
      code: "permission_required" as const,
      permission: "bookmarks" as const,
      capability: "searchBookmarks" as const,
      requestable: true as const,
    };
    expect(PermissionRequiredSchema.parse(required)).toEqual(required);

    const error = new PermissionRequiredError(required);
    expect(parsePermissionRequired(error)).toEqual(required);
    expect(parsePermissionRequired(error.message)).toEqual(required);
  });

  it("does not mistake an unrelated tool failure for a permission request", () => {
    expect(parsePermissionRequired(new Error("searchBookmarks: query required"))).toBeNull();
  });
});
