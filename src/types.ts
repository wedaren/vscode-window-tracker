import { WindowRecord } from './dataManager';

export interface WindowNode extends WindowRecord {
	type: 'window';
 	stableId: string;
 	origin: 'tracked' | 'saved';
 	dirUri?: import('vscode').Uri;
 	relativeActive: string;
 	isSaved?: boolean;
}
