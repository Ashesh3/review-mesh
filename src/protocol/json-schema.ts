import { z } from "zod";
import { reviewerResultV2Schema } from "./schemas.js";

export const reviewerResultJsonSchema = z.toJSONSchema(reviewerResultV2Schema, {
  target: "draft-07",
});
