import express from "express";
import { PORT, REMIX_OUTPUT_DIR } from "./lib/config.js";
import { remixesRouter } from "./routes/remixes.js";
import { skeletonsRouter } from "./routes/skeletons.js";
import { remixesV2Router } from "./v2/routes/remixes.js";

const app = express();

// Mounted before the global JSON parser: it has its own, larger body limit for skeleton files.
app.use("/skeletons", skeletonsRouter);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// v1 is also served at the unversioned /remixes path for older clients.
app.use(["/remixes", "/v1/remixes"], remixesRouter);
app.use("/v2/remixes", remixesV2Router);

// Generated atlases and textures. The Spine viewer loads them with WebGL from the
// frontend's origin, which needs CORS.
app.use(
  "/files/remixes",
  (_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  },
  express.static(REMIX_OUTPUT_DIR, { immutable: true, maxAge: "1y", fallthrough: false }),
);

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
