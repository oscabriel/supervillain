import type { LogError } from "@supervillain/engine";
import { Layer } from "effect";
import { CampaignContent } from "../content/index.ts";
import { Presence } from "./Presence.ts";
import { TableRoom, type TableRoomOptions } from "./TableRoom.ts";

/** What a seat and a one-off command need: the room, who is here, and the campaign's sheets. */
export type TableServices = TableRoom | Presence | CampaignContent;

/** The table's services over one campaign folder. The log is opened (and locked) here. */
export const tableServices = (
  campaignDir: string,
  options: TableRoomOptions = {},
): Layer.Layer<TableServices, LogError> =>
  Layer.mergeAll(
    Presence.layer,
    TableRoom.layer(campaignDir, options),
    CampaignContent.layer(campaignDir),
  );
