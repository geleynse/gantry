import {
  PrayerParseError,
  type AstArg,
  type AstPredicate,
  type AstProgram,
  type AstStmt,
  type CompareOp,
  type MacroName,
  type SourceLoc,
} from "./types.js";

type TokenKind =
  | "ident"
  | "int"
  | "macro"
  | "semi"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "comma"
  | "op"
  | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  loc: SourceLoc;
}

const MACROS = new Set(["here", "home", "nearest_station"]);

export function parsePrayerScript(source: string): AstProgram {
  const parser = new Parser(lex(source), source);
  return { statements: parser.parseProgram(), source };
}

export function formatPrayerProgram(program: AstProgram): string {
  return formatStatements(program.statements, 0).join("\n");
}

function formatStatements(stmts: AstStmt[], indent: number): string[] {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const stmt of stmts) {
    if (stmt.kind === "command") {
      const args = stmt.args.map(formatArg);
      lines.push(`${pad}${[stmt.name, ...args].join(" ")};`);
      continue;
    }
    const keyword = stmt.kind;
    lines.push(`${pad}${keyword} ${formatPredicate(stmt.cond)} {`);
    lines.push(...formatStatements(stmt.body, indent + 1));
    lines.push(`${pad}}`);
  }
  return lines;
}

function formatArg(arg: AstArg): string {
  if (arg.kind === "ident") return arg.name;
  if (arg.kind === "macro") return `$${arg.name}`;
  return String(arg.value);
}

function formatPredicate(pred: AstPredicate): string {
  return `${pred.metric}(${pred.args.map(formatArg).join(", ")}) ${pred.op} ${pred.rhs}`;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[], private readonly source: string) {}

  parseProgram(): AstStmt[] {
    const stmts = this.parseBlockBody("eof");
    this.expect("eof");
    return stmts;
  }

  private parseBlockBody(end: "eof" | "rbrace"): AstStmt[] {
    const stmts: AstStmt[] = [];
    while (!this.at(end) && !this.at("eof")) {
      stmts.push(this.parseStatement());
    }
    if (end === "rbrace" && this.at("eof")) {
      this.fail(this.peek(), "expected '}' before end of script");
    }
    return stmts;
  }

  private parseStatement(): AstStmt {
    const token = this.expect("ident");
    if (token.text === "if" || token.text === "until") {
      const cond = this.parsePredicate();
      this.expect("lbrace");
      const body = this.parseBlockBody("rbrace");
      this.expect("rbrace");
      return { kind: token.text, cond, body, loc: token.loc };
    }

    const args: AstArg[] = [];
    while (!this.at("semi")) {
      if (this.at("eof")) {
        // Trailing semicolon is optional on the last statement at top level
        return { kind: "command", name: token.text, args, loc: token.loc };
      }
      if (this.at("rbrace")) {
        this.fail(this.peek(), "expected ';' after command");
      }
      args.push(this.parseArg());
    }
    this.expect("semi");
    return { kind: "command", name: token.text, args, loc: token.loc };
  }

  private parsePredicate(): AstPredicate {
    const metric = this.expect("ident");
    this.expect("lparen");
    const args: AstArg[] = [];
    if (!this.at("rparen")) {
      args.push(this.parseArg());
      while (this.at("comma")) {
        this.expect("comma");
        args.push(this.parseArg());
      }
    }
    this.expect("rparen");
    const op = this.expect("op");
    const rhs = this.expect("int");
    return {
      metric: metric.text,
      args,
      op: op.text as CompareOp,
      rhs: Number(rhs.text),
      loc: metric.loc,
    };
  }

  private parseArg(): AstArg {
    const token = this.peek();
    if (token.kind === "ident") {
      this.pos++;
      return { kind: "ident", name: token.text, loc: token.loc };
    }
    if (token.kind === "int") {
      this.pos++;
      return { kind: "int", value: Number(token.text), loc: token.loc };
    }
    if (token.kind === "macro") {
      this.pos++;
      const name = token.text.slice(1);
      if (!MACROS.has(name)) {
        this.fail(token, `unknown macro '${token.text}'`);
      }
      return { kind: "macro", name: name as MacroName, loc: token.loc };
    }
    this.fail(token, `expected argument, got '${token.text}'`);
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private expect(kind: TokenKind): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      this.fail(token, `expected ${kind}, got '${token.text}'`);
    }
    this.pos++;
    return token;
  }

  private fail(token: Token, message: string): never {
    throw new PrayerParseError(message, token.loc);
  }
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const loc = (): SourceLoc => ({ line, col });
  const push = (kind: TokenKind, text: string, at: SourceLoc) => tokens.push({ kind, text, loc: at });
  const advance = (n = 1) => {
    for (let j = 0; j < n; j++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      advance();
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") advance();
      continue;
    }

    const at = loc();
    if (ch === ";") { push("semi", ch, at); advance(); continue; }
    if (ch === "{") { push("lbrace", ch, at); advance(); continue; }
    if (ch === "}") { push("rbrace", ch, at); advance(); continue; }
    if (ch === "(") { push("lparen", ch, at); advance(); continue; }
    if (ch === ")") { push("rparen", ch, at); advance(); continue; }
    if (ch === ",") { push("comma", ch, at); advance(); continue; }

    const two = source.slice(i, i + 2);
    if ([">=", "<=", "==", "!="].includes(two)) {
      push("op", two, at);
      advance(2);
      continue;
    }
    if (ch === ">" || ch === "<") {
      push("op", ch, at);
      advance();
      continue;
    }

    if (ch === "$") {
      let text = "$";
      advance();
      while (i < source.length && /[A-Za-z0-9_-]/.test(source[i])) {
        text += source[i];
        advance();
      }
      push("macro", text, at);
      continue;
    }

    if (ch === "-" || /[0-9]/.test(ch)) {
      let text = "";
      if (ch === "-") {
        text += ch;
        advance();
        if (!/[0-9]/.test(source[i] ?? "")) {
          throw new PrayerParseError("expected digit after '-'", at);
        }
      }
      while (i < source.length && /[0-9]/.test(source[i])) {
        text += source[i];
        advance();
      }
      push("int", text, at);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let text = "";
      while (i < source.length && /[A-Za-z0-9_-]/.test(source[i])) {
        text += source[i];
        advance();
      }
      push("ident", text, at);
      continue;
    }

    if (ch === '"' || ch === "'") {
      throw new PrayerParseError(
        `PrayerLang uses bare identifiers, not quoted strings — use \`go foo\` not \`go "foo"\``,
        at,
      );
    }

    throw new PrayerParseError(`unexpected character '${ch}'`, at);
  }

  tokens.push({ kind: "eof", text: "<eof>", loc: { line, col } });
  return tokens;
}
