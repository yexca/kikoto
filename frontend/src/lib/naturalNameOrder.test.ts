import { describe, expect, it } from "vitest";

import { kanjiNumeralValue, naturalNameCompare } from "./naturalNameOrder";

describe("kanjiNumeralValue", () => {
  it("reads numerals written with units", () => {
    expect(kanjiNumeralValue("十")).toBe(10);
    expect(kanjiNumeralValue("十一")).toBe(11);
    expect(kanjiNumeralValue("二十")).toBe(20);
    expect(kanjiNumeralValue("百")).toBe(100);
    expect(kanjiNumeralValue("一百零五")).toBe(105);
    expect(kanjiNumeralValue("三千二百")).toBe(3200);
    expect(kanjiNumeralValue("一万二千")).toBe(12000);
  });

  it("reads numerals written digit by digit", () => {
    expect(kanjiNumeralValue("一〇")).toBe(10);
    expect(kanjiNumeralValue("二〇二四")).toBe(2024);
  });

  it("rejects digits that follow each other between units", () => {
    expect(kanjiNumeralValue("二三十")).toBeNull();
  });
});

describe("naturalNameCompare", () => {
  it("orders kanji ordinals by the number they write", () => {
    const names = ["第十一話", "第二話", "第百話", "第一話", "第十話", "第二十話", "第九話", "第三話"];
    expect(names.sort(naturalNameCompare)).toEqual([
      "第一話",
      "第二話",
      "第三話",
      "第九話",
      "第十話",
      "第十一話",
      "第二十話",
      "第百話",
    ]);
  });

  it("orders kanji ordinals among arabic ones and keeps equal values in a stable order", () => {
    const names = ["第10章", "第二章", "第1章", "第一章"];
    expect(names.sort(naturalNameCompare)).toEqual(["第1章", "第一章", "第二章", "第10章"]);
  });

  it("orders a numbered folder's tracks after the ordinal", () => {
    const names = ["第二部/10.mp3", "第一部/2.mp3", "第二部/2.mp3", "第一部/10.mp3"];
    expect(names.sort(naturalNameCompare)).toEqual(["第一部/2.mp3", "第一部/10.mp3", "第二部/2.mp3", "第二部/10.mp3"]);
  });
});
