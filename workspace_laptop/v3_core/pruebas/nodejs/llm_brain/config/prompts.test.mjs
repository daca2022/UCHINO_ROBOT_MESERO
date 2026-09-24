import { describe, test, expect } from "bun:test";
import { SPANISH_CAFE_PROMPT } from "../../src/config/prompts/qwen_flash_system.mjs";
import { FEWSHOT_EXAMPLES } from "../../src/config/prompts/qwen_flash_fewshots.mjs";

const FUNCTION_NAMES = [
  'registrar_pedido',
  'confirmar_pedido',
  'cancelar_pedido',
  'ir_a_lugar',
  'expresar_emocion',
  'mostrar_menu',
  'guardar_memoria',
];

describe("qwen_flash_system.mjs", () => {
  test("system prompt is non-empty and in Spanish", () => {
    expect(SPANISH_CAFE_PROMPT.length).toBeGreaterThan(0);
    expect(SPANISH_CAFE_PROMPT).toContain("Chipi");
    expect(SPANISH_CAFE_PROMPT).toContain("español peruano");
  });

  test("system prompt contains key Peruvian terms", () => {
    expect(SPANISH_CAFE_PROMPT).toContain("palta");
    expect(SPANISH_CAFE_PROMPT).toContain("sánguche");
    expect(SPANISH_CAFE_PROMPT).toContain("al toque");
  });

  test("system prompt contains all 7 function names", () => {
    for (const fn of FUNCTION_NAMES) {
      expect(SPANISH_CAFE_PROMPT).toContain(fn);
    }
  });

  test("system prompt is under 4000 chars (token efficient)", () => {
    expect(SPANISH_CAFE_PROMPT.length).toBeLessThan(4000);
  });

  test("system prompt mentions response brevity", () => {
    expect(SPANISH_CAFE_PROMPT).toMatch(/1-3 oraciones|Sé conciso|breve/i);
  });
});

describe("qwen_flash_fewshots.mjs", () => {
  test("fewshot examples array is non-empty", () => {
    expect(FEWSHOT_EXAMPLES.length).toBeGreaterThan(0);
  });

  test("each example has role and content", () => {
    for (const ex of FEWSHOT_EXAMPLES) {
      expect(ex).toHaveProperty("role");
      expect(ex).toHaveProperty("content");
      expect(["user", "assistant"]).toContain(ex.role);
      expect(typeof ex.content).toBe("string");
      expect(ex.content.length).toBeGreaterThan(0);
    }
  });

  test("at least one fewshot includes tool_calls", () => {
    const withTools = FEWSHOT_EXAMPLES.filter(
      (ex) => ex.tool_calls !== null && ex.tool_calls !== undefined
    );
    expect(withTools.length).toBeGreaterThan(0);
  });

  test("tool_calls have name and args structure", () => {
    const withTools = FEWSHOT_EXAMPLES.filter(
      (ex) => Array.isArray(ex.tool_calls) && ex.tool_calls.length > 0
    );
    expect(withTools.length).toBeGreaterThan(0);
    for (const ex of withTools) {
      for (const tc of ex.tool_calls) {
        expect(tc).toHaveProperty("name");
        expect(tc).toHaveProperty("args");
        expect(typeof tc.name).toBe("string");
      }
    }
  });

  test("fewshot examples cover greeting scenario", () => {
    const greetings = FEWSHOT_EXAMPLES.filter(
      (ex) =>
        ex.role === "user" &&
        /hola|buenos días|buenas tardes/i.test(ex.content)
    );
    expect(greetings.length).toBeGreaterThan(0);
  });

  test("fewshot examples cover order registration", () => {
    const orderCalls = FEWSHOT_EXAMPLES.filter(
      (ex) =>
        Array.isArray(ex.tool_calls) &&
        ex.tool_calls.some((tc) => tc.name === "registrar_pedido")
    );
    expect(orderCalls.length).toBeGreaterThan(0);
  });

  test("fewshot examples cover unavailable item handling", () => {
    const unavailable = FEWSHOT_EXAMPLES.filter(
      (ex) =>
        ex.role === "assistant" &&
        /no tenemos|disculpe|no está|no disponible/i.test(ex.content)
    );
    expect(unavailable.length).toBeGreaterThan(0);
  });
});
