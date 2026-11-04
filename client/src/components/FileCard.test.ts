import { describe, expect, it } from "vitest";
import { splitPath } from "./FileCard";

describe("splitPath", () => {
  it("splits a project path into the file name and its folder", () => {
    expect(splitPath("report.pdf")).toEqual({ name: "report.pdf", folder: "" });
    expect(splitPath("out/q3/report.docx")).toEqual({ name: "report.docx", folder: "out/q3" });
    expect(splitPath(String.raw`out\report.pdf`)).toEqual({ name: "report.pdf", folder: "out" });
  });
});
