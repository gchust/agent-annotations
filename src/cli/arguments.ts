export type ParsedCliArguments = {
  command: string | null;
  args: string[];
  root: string | null;
  dir: string | null;
};

export type ParseCliArgumentsResult =
  | ParsedCliArguments
  | { error: string };

const GLOBAL_OPTIONS = new Set(["--root", "--dir"]);

// Hand-written, dependency-free parser for the public CLI surface:
//   agent-annotations [--root <path>] [--dir <path>] <command> [args...]
// `--root` and `--dir` may appear before or after the command but each at most
// once. The first non-option token is the command; every other token (in
// original order) is passed to the command. Unknown option tokens before the
// command, duplicate global options, and missing option values are usage
// errors (exit code 2) rather than silent no-ops.
export const parseCliArguments = (argv: string[]): ParseCliArgumentsResult => {
  let command: string | null = null;
  let root: string | null = null;
  let dir: string | null = null;
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (GLOBAL_OPTIONS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${token} requires a value` };
      if (token === "--root") {
        if (root !== null) return { error: "duplicate --root" };
        root = value;
      } else {
        if (dir !== null) return { error: "duplicate --dir" };
        dir = value;
      }
      index += 1;
      continue;
    }
    if (command === null) {
      if (token.startsWith("-")) {
        if (token === "--help" || token === "-h") {
          return { command: null, args: [], root, dir };
        }
        return { error: `unknown option: ${token}` };
      }
      command = token;
      continue;
    }
    args.push(token);
  }
  return { command, args, root, dir };
};
