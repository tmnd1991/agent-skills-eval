// Fake opencode HTTP server for tests. Implements just the handful of
// `@opencode-ai/sdk` endpoints OpencodeProvider calls (session create/prompt/
// status/children/messages), scripted by marker strings in the prompt text,
// mimicking the real server's shapes closely enough to exercise the
// provider's polling/continuation logic without a real opencode install.
import { createServer } from "node:http";

const DELEGATE_SETTLE_MS = 300;

function respondJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) return resolve(undefined);
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function createFakeOpencodeServer() {
  const requests = [];
  const sessions = new Map();
  let counter = 0;
  const nextId = (prefix) => `${prefix}_${++counter}`;

  function makeSession(parentID) {
    const id = nextId("ses");
    const session = {
      id,
      projectID: "test-project",
      directory: "/tmp/fake-opencode",
      parentID,
      title: "fake session",
      version: "0.0.0-test",
      time: { created: Date.now(), updated: Date.now() },
      messages: [],
      status: { type: "idle" },
      scenario: undefined,
      step: 0,
    };
    sessions.set(id, session);
    return session;
  }

  function assistantMessage(sessionId, text, overrides = {}) {
    const msgId = nextId("msg");
    return {
      info: {
        id: msgId,
        sessionID: sessionId,
        role: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        parentID: "",
        modelID: "fake-model",
        providerID: "fake",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: overrides.cost ?? 0.0001,
        tokens: overrides.tokens ?? { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
        ...(overrides.error ? { error: overrides.error } : {}),
      },
      parts: [{ id: nextId("prt"), sessionID: sessionId, messageID: msgId, type: "text", text }],
    };
  }

  function taskNotification(sessionId, text) {
    const msgId = nextId("msg");
    return {
      info: {
        id: msgId,
        sessionID: sessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "fake", modelID: "fake-model" },
      },
      parts: [{ id: nextId("prt"), sessionID: sessionId, messageID: msgId, type: "text", text }],
    };
  }

  function triggerDelegation(session) {
    const child = makeSession(session.id);
    child.status = { type: "busy" };
    setTimeout(() => {
      child.status = { type: "idle" };
      session.messages.push(taskNotification(session.id, "<task-notification><status>completed</status></task-notification>"));
    }, DELEGATE_SETTLE_MS);
  }

  function handlePrompt(session, text, res) {
    requests.push({ sessionId: session.id, text });

    if (session.step === 0) {
      if (text.includes("__FAKE_OPENCODE_ERROR__")) {
        session.scenario = "error";
      } else if (text.includes("__FAKE_OPENCODE_HANG__")) {
        session.scenario = "hang";
      } else if (text.includes("__FAKE_OPENCODE_DELEGATE_RACE__")) {
        session.scenario = "delegate-race";
      } else if (text.includes("__FAKE_OPENCODE_INFINITE_DELEGATE__")) {
        session.scenario = "infinite-delegate";
      } else if (text.startsWith("__FAKE_OPENCODE_ECHO__")) {
        session.scenario = "echo";
      } else if (/Assertions:\n[\s\S]*?\nModel output:/.test(text)) {
        session.scenario = "judge";
      } else {
        session.scenario = "default";
      }
    }
    session.step += 1;

    switch (session.scenario) {
      case "error":
        respondJson(res, 500, { name: "UnknownError", data: { message: "fake opencode error" } });
        return;
      case "hang":
        // Never respond — the client's own AbortSignal.timeout must fire.
        return;
      case "echo": {
        const payload = text.replace("__FAKE_OPENCODE_ECHO__ ", "");
        const message = assistantMessage(session.id, payload);
        session.messages.push(message);
        respondJson(res, 200, message);
        return;
      }
      case "judge": {
        const match = text.match(/Assertions:\n([\s\S]*?)\nModel output:/);
        let assertions = [];
        try {
          assertions = match ? JSON.parse(match[1]) : [];
        } catch {
          assertions = [];
        }
        const assertionResults = assertions.map((a) => ({
          text: a,
          passed: true,
          evidence: "fake judge: assumed satisfied",
        }));
        const passed = assertionResults.length;
        const grading = {
          assertion_results: assertionResults,
          summary: { passed, failed: 0, total: passed, pass_rate: passed > 0 ? 1 : 0 },
        };
        const message = assistantMessage(session.id, JSON.stringify(grading));
        session.messages.push(message);
        respondJson(res, 200, message);
        return;
      }
      case "delegate-race": {
        if (session.step === 1) {
          const message = assistantMessage(session.id, "Delegation running. I'll synthesize when it returns.");
          session.messages.push(message);
          triggerDelegation(session);
          respondJson(res, 200, message);
        } else {
          const message = assistantMessage(session.id, "FAKE_OPENCODE_REAL_ANSWER");
          session.messages.push(message);
          respondJson(res, 200, message);
        }
        return;
      }
      case "infinite-delegate": {
        const message = assistantMessage(session.id, `Delegation running (round ${session.step}).`);
        session.messages.push(message);
        triggerDelegation(session);
        respondJson(res, 200, message);
        return;
      }
      default: {
        const message = assistantMessage(session.id, "FAKE_OPENCODE_OK");
        session.messages.push(message);
        respondJson(res, 200, message);
      }
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "POST" && url.pathname === "/session") {
        const session = makeSession(undefined);
        respondJson(res, 200, session);
        return;
      }

      const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (req.method === "POST" && messageMatch) {
        const session = sessions.get(messageMatch[1]);
        if (!session) return respondJson(res, 404, { name: "UnknownError", data: { message: "no such session" } });
        const body = await readJsonBody(req);
        const text = body?.parts?.find((p) => p.type === "text")?.text ?? "";
        handlePrompt(session, text, res);
        return;
      }

      if (req.method === "GET" && messageMatch) {
        const session = sessions.get(messageMatch[1]);
        if (!session) return respondJson(res, 404, { name: "UnknownError", data: { message: "no such session" } });
        respondJson(res, 200, session.messages);
        return;
      }

      const childrenMatch = url.pathname.match(/^\/session\/([^/]+)\/children$/);
      if (req.method === "GET" && childrenMatch) {
        const children = [...sessions.values()].filter((s) => s.parentID === childrenMatch[1]);
        respondJson(res, 200, children);
        return;
      }

      if (req.method === "GET" && url.pathname === "/session/status") {
        const statusById = {};
        for (const session of sessions.values()) statusById[session.id] = session.status;
        respondJson(res, 200, statusById);
        return;
      }

      respondJson(res, 404, { name: "UnknownError", data: { message: `no fake route for ${req.method} ${url.pathname}` } });
    } catch (err) {
      respondJson(res, 500, { name: "UnknownError", data: { message: err instanceof Error ? err.message : String(err) } });
    }
  });

  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        sessions,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(done);
          }),
      });
    });
  });
}
