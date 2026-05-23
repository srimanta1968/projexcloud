import type { CedarTerm, IQLNode } from '../models/policy.model';

/**
 * IQL (Identity Query Language) parser per PRD §5.4 / FR-POL-7.
 *
 * Grammar (canonical examples from PRD US-PE-3):
 *   subject.persona(role="doctor")
 *   relationship(type="care-team", target="encounter.patient")
 *   encounter(active=true)
 *   subject.bu.ancestor(bu_id="bu_xyz")
 *
 * Combinators:  expr AND expr  |  expr OR expr  |  NOT expr  |  ( expr )
 *
 * Parses to an AST then compileToCedar(node) emits a Cedar term shape that
 * downstream Cedar evaluators (PRD R-2 — frozen at week 11) can consume.
 */

type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' }
  | { kind: 'dot' }
  | { kind: 'eq' }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'not' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (c === ',') { tokens.push({ kind: 'comma' }); i++; continue; }
    if (c === '.') { tokens.push({ kind: 'dot' }); i++; continue; }
    if (c === '=') { tokens.push({ kind: 'eq' }); i++; continue; }
    if (c === '"') {
      let end = i + 1;
      while (end < src.length && src[end] !== '"') end++;
      if (end >= src.length) throw new Error(`Unterminated string at ${i}`);
      tokens.push({ kind: 'string', value: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let end = i;
      while (end < src.length && /[A-Za-z0-9_]/.test(src[end])) end++;
      const word = src.slice(i, end);
      if (word === 'and' || word === 'AND') tokens.push({ kind: 'and' });
      else if (word === 'or' || word === 'OR') tokens.push({ kind: 'or' });
      else if (word === 'not' || word === 'NOT') tokens.push({ kind: 'not' });
      else if (word === 'true') tokens.push({ kind: 'bool', value: true });
      else if (word === 'false') tokens.push({ kind: 'bool', value: false });
      else tokens.push({ kind: 'ident', value: word });
      i = end;
      continue;
    }
    throw new Error(`Unexpected character ${c} at ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): IQLNode {
    const node = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token at position ${this.pos}: ${JSON.stringify(this.tokens[this.pos])}`);
    }
    return node;
  }

  private parseOr(): IQLNode {
    let left = this.parseAnd();
    while (this.peek()?.kind === 'or') {
      this.pos++;
      const right = this.parseAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): IQLNode {
    let left = this.parseNot();
    while (this.peek()?.kind === 'and') {
      this.pos++;
      const right = this.parseNot();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parseNot(): IQLNode {
    if (this.peek()?.kind === 'not') {
      this.pos++;
      return { kind: 'not', inner: this.parseAtom() };
    }
    return this.parseAtom();
  }

  private parseAtom(): IQLNode {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of input');
    if (t.kind === 'lparen') {
      this.pos++;
      const inner = this.parseOr();
      this.expect('rparen');
      return inner;
    }
    if (t.kind === 'ident') {
      return this.parseCall();
    }
    throw new Error(`Expected expression, got ${JSON.stringify(t)}`);
  }

  private parseCall(): IQLNode {
    const parts: string[] = [];
    while (this.peek()?.kind === 'ident' || this.peek()?.kind === 'dot') {
      const tok = this.tokens[this.pos];
      if (tok.kind === 'ident') parts.push(tok.value);
      this.pos++;
    }
    const path = parts.join('.');
    this.expect('lparen');
    const args = this.parseArgList();
    this.expect('rparen');

    if (path === 'subject.persona') {
      const role = String(args.role ?? '');
      if (!role) throw new Error('subject.persona requires role= argument');
      return { kind: 'subject_persona', role };
    }
    if (path === 'subject.bu.ancestor') {
      const bu_id = String(args.bu_id ?? '');
      if (!bu_id) throw new Error('subject.bu.ancestor requires bu_id= argument');
      return { kind: 'subject_bu_ancestor', bu_id };
    }
    if (path === 'relationship') {
      const type = String(args.type ?? '');
      if (!type) throw new Error('relationship requires type= argument');
      return { kind: 'relationship', type, target: args.target ? String(args.target) : undefined };
    }
    if (path === 'encounter') {
      const active = args.active !== undefined ? Boolean(args.active) : undefined;
      return { kind: 'encounter', active };
    }
    throw new Error(`Unknown IQL function: ${path}`);
  }

  private parseArgList(): Record<string, string | boolean> {
    const args: Record<string, string | boolean> = {};
    while (this.peek() && this.peek()!.kind !== 'rparen') {
      const key = this.tokens[this.pos];
      if (key.kind !== 'ident') throw new Error('Expected argument name');
      this.pos++;
      this.expect('eq');
      const val = this.tokens[this.pos];
      if (val.kind === 'string') args[key.value] = val.value;
      else if (val.kind === 'bool') args[key.value] = val.value;
      else throw new Error(`Expected literal value for ${key.value}, got ${JSON.stringify(val)}`);
      this.pos++;
      if (this.peek()?.kind === 'comma') this.pos++;
    }
    return args;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expect(kind: Token['kind']): void {
    const t = this.tokens[this.pos];
    if (!t || t.kind !== kind) {
      throw new Error(`Expected ${kind}, got ${t ? JSON.stringify(t) : 'EOF'}`);
    }
    this.pos++;
  }
}

/**
 * Parses an IQL source string into the typed AST. Throws on grammar errors.
 */
export function parseIQL(source: string): IQLNode {
  return new Parser(tokenize(source)).parse();
}

/**
 * Compiles an IQL AST to a Cedar-shaped term. The shape is intentionally
 * Cedar-compatible (effect/principal/action/resource/conditions) so the same
 * evaluator can ingest hand-written Cedar OR IQL-compiled output.
 */
export function compileToCedar(node: IQLNode): CedarTerm {
  return {
    effect: 'permit',
    principal_kind: 'Persona',
    action: 'read',
    resource_kind: 'Resource',
    conditions: [iqlToCondition(node)],
  };
}

function iqlToCondition(node: IQLNode): Record<string, unknown> {
  switch (node.kind) {
    case 'subject_persona':
      return { op: 'eq', left: 'subject.persona.role', right: node.role };
    case 'subject_bu_ancestor':
      return { op: 'contains', left: 'subject.bu.ancestors', right: node.bu_id };
    case 'relationship':
      return node.target
        ? { op: 'rebac', kind: node.type, target: node.target }
        : { op: 'rebac_exists', kind: node.type };
    case 'encounter':
      return node.active === undefined
        ? { op: 'encounter_present', value: true }
        : { op: 'eq', left: 'encounter.active', right: node.active };
    case 'and':
      return { op: 'and', left: iqlToCondition(node.left), right: iqlToCondition(node.right) };
    case 'or':
      return { op: 'or', left: iqlToCondition(node.left), right: iqlToCondition(node.right) };
    case 'not':
      return { op: 'not', inner: iqlToCondition(node.inner) };
  }
}

/**
 * Evaluates a compiled Cedar term against a plain context object. Used by
 * the policy evaluator on cache miss / fresh compute.
 */
export function evaluateCedar(term: CedarTerm, context: Record<string, unknown>): boolean {
  return term.conditions.every((c) => evalCondition(c, context));
}

function evalCondition(c: Record<string, unknown>, ctx: Record<string, unknown>): boolean {
  const op = c.op as string;
  if (op === 'and') return evalCondition(c.left as Record<string, unknown>, ctx) && evalCondition(c.right as Record<string, unknown>, ctx);
  if (op === 'or') return evalCondition(c.left as Record<string, unknown>, ctx) || evalCondition(c.right as Record<string, unknown>, ctx);
  if (op === 'not') return !evalCondition(c.inner as Record<string, unknown>, ctx);
  if (op === 'eq') return resolvePath(ctx, c.left as string) === c.right;
  if (op === 'contains') {
    const value = resolvePath(ctx, c.left as string);
    return Array.isArray(value) && value.includes(c.right as never);
  }
  if (op === 'encounter_present') {
    return ctx.encounter !== undefined && ctx.encounter !== null;
  }
  if (op === 'rebac' || op === 'rebac_exists') {
    const rebac = ctx.rebac as Record<string, boolean> | undefined;
    if (!rebac) return false;
    const key = op === 'rebac' ? `${c.kind}:${c.target}` : `${c.kind}:*`;
    return rebac[key] === true;
  }
  return false;
}

function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc === undefined || acc === null) return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, ctx);
}
