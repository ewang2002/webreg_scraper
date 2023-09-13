export interface IContext {
    credentials: ICredentials;
    termInfo: ITermInfo | null;
    session: ISession;
}

export interface ISession {
    /**
     * When this instance started, represented as a unix timestamp
     */
    start: number;
    /**
     * Whenever a *successful* call to this API occurs (for login cookies),
     * add the unix timestamp corresponding to the time of the request
     * here.
     */
    callHistory: number[];
}

export interface ICredentials {
    username: string;
    password: string;
}

export interface ITermInfo {
    seqId: number;
    termName: string;
}