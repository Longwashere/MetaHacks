import express from "express";
import { PORT, REMIX_OUTPUT_DIR } from "./lib/config.js";
import { remixesRouter } from "./routes/remixes.js";

const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/remixes", remixesRouter);

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
