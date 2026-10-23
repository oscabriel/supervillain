import type { LogError } from "@supervillain/engine";
import { Layer } from "effect";
import {
  type CampaignConfigInvalid,
  CampaignContent,
  type ContentReadError,
} from "../content/index.ts";
import { Presence } from "./Presence.ts";
import { SetWorld } from "./SetWorld.ts";
import { TableRoom, type TableRoomOptions } from "./TableRoom.ts";

/**
 * What a seat and a one-off command need: the room, who is here, the campaign (its ruleset and
 * sheets), and set.world, where a set.world table rolls its fighters.
 */
export type TableServices = TableRoom | Presence | CampaignContent | SetWorld;

export interface TableServicesOptions extends TableRoomOptions {
  /** Where fighters are rolled: the live API unless a test says otherwise. */
  readonly setWorld?: Layer.Layer<SetWorld>;
}

/**
 * The table's services over one campaign folder. The log is opened (and locked) here, and
 * `campaign.yaml` read: a ruleset the table doesn't know stops it opening.
 */
export const tableServices = (
  campaignDir: string,
  options: TableServicesOptions = {},
): Layer.Layer<TableServices, LogError | CampaignConfigInvalid | ContentReadError> =>
  Layer.mergeAll(
    Presence.layer,
    TableRoom.layer(campaignDir, options),
    CampaignContent.layer(campaignDir),
    options.setWorld ?? SetWorld.layer,
  );
