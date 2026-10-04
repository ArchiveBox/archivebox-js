export function initializeGit(document:Document,captures:{path:string;plugin:string;size:number;root?:boolean}[],options:{source:string;page:string;openFiles:()=>void;fileURL:(path:string)=>string}):void;
export function initializeGitCard(document:Document,captures:{path:string;plugin:string;size:number;root?:boolean}[],options:{source:string;page:string}):Promise<void>;
