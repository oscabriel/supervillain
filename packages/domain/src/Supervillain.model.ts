import * as Domain from "@alchemy.run/domain";

import { Table } from "./Table.aggregate.ts";

export class Supervillain extends Domain.Model("Supervillain", {
	aggregates: [Table],
}) {}
