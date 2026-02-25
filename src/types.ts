import { WindowRecord } from './dataManager';

// Shared WindowNode shape used by tree provider and managers
export interface WindowNode extends WindowRecord {
	type: 'window';
	stableId: string;
	origin: 'tracked' | 'added';
	dirUri?: import('vscode').Uri;
	relativeActive: string;
	// true when the item (regardless of origin) exists in the user's "added" list
	isAdded?: boolean;
}
