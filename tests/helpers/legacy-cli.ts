// Historical CLI fixture: the shipping entrypoint always invokes v9.
import { runCli } from "../../src/cli.js";
import { runLegacyReviewApplication } from "../../src/app.js";

await runCli(process, { runReview: runLegacyReviewApplication });
