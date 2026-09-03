import { createApp } from "./app";
import { logger } from "./logger";

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(port, () => {
  logger.info("server gestart", { port });
});
