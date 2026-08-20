import { describe, expect, it } from "vitest";

import { parseCliArguments } from "../../src/cli/arguments.js";

describe("CLI argument parsing", () => {
  it("extracts the command and keeps command arguments in order", () => {
    expect(parseCliArguments(["list"])).toEqual({ command: "list", args: [], root: null, dir: null });
    expect(parseCliArguments(["wait", "--source-revision", "abc", "--timeout-ms", "0", "--json"])).toEqual({
      command: "wait",
      args: ["--source-revision", "abc", "--timeout-ms", "0", "--json"],
      root: null,
      dir: null,
    });
  });

  it("accepts --root and --dir before or after the command, each once", () => {
    expect(parseCliArguments(["--root", "/a", "--dir", "/b", "revision", "--json"])).toEqual({
      command: "revision",
      args: ["--json"],
      root: "/a",
      dir: "/b",
    });
    expect(parseCliArguments(["revision", "--json", "--root", "/a", "--dir", "/b"])).toEqual({
      command: "revision",
      args: ["--json"],
      root: "/a",
      dir: "/b",
    });
    expect(parseCliArguments(["--dir", "/b", "list"])).toEqual({
      command: "list",
      args: [],
      root: null,
      dir: "/b",
    });
  });

  it("treats help tokens before the command as help", () => {
    expect(parseCliArguments(["--help"])).toEqual({ command: null, args: [], root: null, dir: null });
    expect(parseCliArguments(["-h", "--root", "/a"])).toEqual({ command: null, args: [], root: null, dir: null });
    expect(parseCliArguments(["help"])).toEqual({ command: "help", args: [], root: null, dir: null });
  });

  it("rejects duplicate options, missing values, and unknown pre-command flags", () => {
    expect(parseCliArguments(["--root", "/a", "--root", "/b", "list"])).toEqual({ error: "duplicate --root" });
    expect(parseCliArguments(["--dir", "/a", "--dir", "/b", "list"])).toEqual({ error: "duplicate --dir" });
    expect(parseCliArguments(["list", "--root"])).toEqual({ error: "--root requires a value" });
    expect(parseCliArguments(["--dir"])).toEqual({ error: "--dir requires a value" });
    expect(parseCliArguments(["--bogus", "list"])).toEqual({ error: "unknown option: --bogus" });
  });
});
