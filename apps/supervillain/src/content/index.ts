// Hero and monster content at the host edge: the YAML files a GM writes, the loader that reads
// them from a campaign folder, and the Steel Compendium import. The rules never see a file; the
// host loads a sheet here and puts it in the command.
export { CampaignContent, type LoadError } from "./CampaignContent.ts";
export {
  ContentReadError,
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
