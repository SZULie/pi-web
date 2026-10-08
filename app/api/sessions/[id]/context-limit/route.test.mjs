import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

function put(id, body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(
    new Request(`http://localhost/api/sessions/${id}/context-limit`, {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function get(id) {
  return GET(
    new Request(`http://localhost/api/sessions/${id}/context-limit`, {
      headers: { host: "localhost" },
    }),
    { params: Promise.resolve({ id }) },
  );
}

test("context-limit route supports GET and PUT updates for a session", async () => {
  const testId = `sess-route-${Date.now()}`;

  const initial = await (await get(testId)).json();
  assert.equal(initial.sessionId, testId);
  assert.equal(initial.customLimit, null);

  const putRes = await (await put(testId, { contextLimit: "270k", thresholdPercent: 70 })).json();
  assert.equal(putRes.success, true);
  assert.equal(putRes.customLimit, 270000);
  assert.equal(putRes.thresholdPercent, 70);

  const afterPut = await (await get(testId)).json();
  assert.equal(afterPut.customLimit, 270000);
  assert.equal(afterPut.thresholdPercent, 70);

  // Clear
  const clearRes = await (await put(testId, { contextLimit: null, thresholdPercent: null })).json();
  assert.equal(clearRes.success, true);
  assert.equal(clearRes.customLimit, null);

  const afterClear = await (await get(testId)).json();
  assert.equal(afterClear.customLimit, null);
});
