import { z } from "zod";
import { reviewerResultSchema } from "./schemas.js";

export const reviewerResultJsonSchema = z.toJSONSchema(reviewerResultSchema, {
  target: "draft-07",
});
