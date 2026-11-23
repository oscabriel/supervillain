import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

export class Refused extends Domain.Rejection(
	"Refused",
	{ message: Schema.String },
	{ httpApiStatus: 422 }
) {}
