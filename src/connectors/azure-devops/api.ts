export interface AdoIdentity {
  displayName?: string;
  uniqueName?: string; // e-mail: never stored
}
export interface AdoWorkItem {
  id: number;
  fields: Record<string, unknown>; // System.CreatedBy / Microsoft.VSTS.* etc., see FIELDS
}
export interface AdoComment {
  text?: string; // HTML
  createdBy?: AdoIdentity;
  createdDate: string;
}

export interface AzureDevOpsApi {
  /** WIQL query: ids only, in query order. */
  queryIds(wiql: string): Promise<number[]>;
  /** At most 200 ids per call. */
  getWorkItems(ids: number[]): Promise<AdoWorkItem[]>;
  /** Every comment of a work item, following continuation tokens. */
  comments(id: number): Promise<AdoComment[]>;
}
