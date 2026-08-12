import { describe, expect, it } from "vitest";
import { groupLegsByRendition, buildRenditionUrl } from "../../src/rendition/group.js";
import type { LegConfig } from "../../src/config/schema.js";

function leg(id: string, renditionId: string, enabled = true): LegConfig {
  return {
    id,
    enabled,
    renditionId,
    priority: 0,
    type: "local-file",
    outputDir: "recordings",
    filenamePattern: `${id}_{timestamp}.mp4`,
  };
}

describe("groupLegsByRendition", () => {
  it("groups legs sharing the same renditionId together", () => {
    const legs = [leg("platform-a", "1080p60"), leg("platform-c", "1080p60"), leg("archive", "source-cq19")];
    const groups = groupLegsByRendition(legs);
    expect(groups.size).toBe(2);
    expect(groups.get("1080p60")?.map((l) => l.id)).toEqual(["platform-a", "platform-c"]);
    expect(groups.get("source-cq19")?.map((l) => l.id)).toEqual(["archive"]);
  });

  it("excludes disabled legs", () => {
    const legs = [leg("platform-a", "1080p60"), leg("platform-b", "1080p60", false)];
    const groups = groupLegsByRendition(legs);
    expect(groups.get("1080p60")?.map((l) => l.id)).toEqual(["platform-a"]);
  });
});

describe("buildRenditionUrl", () => {
  it("derives the rendition path from the relay URL's host/port", () => {
    expect(buildRenditionUrl("rtmp://127.0.0.1:1935/relay/live", "1080p60")).toBe(
      "rtmp://127.0.0.1:1935/rendition/1080p60",
    );
  });
});
