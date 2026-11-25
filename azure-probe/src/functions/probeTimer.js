const { app } = require("@azure/functions");
const { runProbeAndPush } = require("../probeLogic");

app.timer("probeTimer", {
  schedule: "0 */15 * * * *",
  runOnStartup: false,
  handler: async (_myTimer, context) => {
    await runProbeAndPush(process.env, context);
  },
});
