import { describe, expect, it } from "vitest";
import { serverFormFromURL, serverURLFromForm } from "./serverConnectionForm";

describe("server connection form", () => {
  it.each([
    ["https://source.example.invalid", "443"],
    ["https://source.example.invalid:443/kikoto", "443"],
    ["http://source.example.invalid", "80"],
    ["http://source.example.invalid:80/kikoto", "80"],
    ["https://source.example.invalid:8443/kikoto", "8443"],
    ["http://source.example.invalid:7655", "7655"],
    ["https://[::1]/kikoto", "443"],
    ["http://[::1]:7655/kikoto", "7655"],
  ])("preserves the saved destination when retrying %s", (savedURL, port) => {
    const form = serverFormFromURL(savedURL);
    expect(form.port).toBe(port);
    expect(new URL(serverURLFromForm(form.protocol, form.address, form.port)).href).toBe(new URL(savedURL).href);
  });

  it("defaults to the Kikoto port when setting up a server for the first time", () => {
    expect(serverFormFromURL("")).toEqual({ protocol: "http", address: "", port: "7655" });
  });
});
