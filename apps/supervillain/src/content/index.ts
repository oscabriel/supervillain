// Content at the host edge: the campaign's settings (campaign.yaml), the YAML sheets and text maps
// a GM writes, the loader that reads them from a campaign folder, and the Steel Compendium import.
// The rules never see a file; the host loads a sheet or map here and puts it in the command.
export {
  CampaignContent,
  type LoadedMap,
  type LoadError,
  type MapLoadError,
} from "./CampaignContent.ts";
export {
  CAMPAIGN_FILE,
  type CampaignConfig,
  campaignYaml,
  readCampaignConfig,
} from "./campaignFile.ts";
export {
  CampaignConfigInvalid,
  ContentReadError,
  MapInvalid,
  MapNotFound,
  SheetAmbiguous,
  SheetInvalid,
  SheetKind,
  SheetNotFound,
} from "./errors.ts";
export {
  CHARACTERISTICS,
  decodeHero,
  decodeMonster,
  idOf,
  monsterYaml,
  ORGANIZATIONS,
} from "./sheetFiles.ts";
export {
  type Converted,
  convertMonster,
  importBestiary,
  type ImportedMonster,
  type ImportOptions,
  type ImportReport,
  importReportText,
  slug,
} from "./steelCompendium.ts";
export { decodeMap, MAP_BYTES } from "./mapFiles.ts";
