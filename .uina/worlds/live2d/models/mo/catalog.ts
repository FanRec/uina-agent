import type { ModelRig } from "../../adapter/rig.js";
import { compileCatalog, type CatalogSnapshot, type CatalogSource } from "../../authoring/catalog.js";
import { MO_MODEL_ID } from "../rig-loader.js";

/** MO-specific actions and named state presets are empty until they are rebuilt. */
export const MO_CATALOG_SOURCE: CatalogSource = {};

export function compileMOCatalog(rig: ModelRig): CatalogSnapshot {
	return compileCatalog(MO_MODEL_ID, MO_CATALOG_SOURCE, rig);
}

export function loadCatalog(modelID: string, rig: ModelRig): CatalogSnapshot | undefined {
	if (modelID === MO_MODEL_ID && rig.modelID === MO_MODEL_ID) return compileMOCatalog(rig);
	return undefined;
}
