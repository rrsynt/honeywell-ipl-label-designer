/**
 * MaxiCode's Structured Carrier Message (AIM ITS/SCM), shared by the languages
 * that spell it differently.
 *
 * In modes 2 and 3 a MaxiCode carries a postcode, a country code and a service
 * class BESIDE the message body. The encoder takes all four INSIDE the data,
 * GS-separated, in the AIM order:
 *
 *     postcode <GS> country <GS> serviceClass <GS> body
 *
 * and it rejects a bare payload for those modes outright. That is not a
 * preference: `buildBwipSpec` returns a spec either way, but bwip throws
 * `maxicodeExpectedPostCode` when the encoder is actually called, so the field
 * falls back to a placeholder box and the bar code disappears. Verified by
 * calling `measureBarcode` — the spec alone proves nothing here.
 *
 * Neither printer spells the fields that way. Both take them as separate
 * parameters, and the two disagree with each other AND with AIM:
 *
 *     TSPL  MAXICODE x,y,mode,class,country,post,...   (TSC manual p. 54)
 *     EPL   b x,y,M,M2,"class,country,post,body"       (EPL manual p. 3-26)
 *
 * so each parser reassembles them into this one canonical form, and the TSPL
 * generator decomposes it again on the way out.
 */

/** The AIM field separator MaxiCode's structured modes are built from. */
export const MAXICODE_GS = '\x1d';

export interface MaxiCodeScm {
    postcode: string;
    country: string;
    serviceClass: string;
    body: string;
}

export const buildMaxiCodeScm = ({ postcode, country, serviceClass, body }: MaxiCodeScm): string =>
    [postcode, country, serviceClass, body].join(MAXICODE_GS);

/**
 * Splits an SCM back into its four fields, or null when the data is not one.
 * Used by the TSPL generator, whose `MAXICODE` command has no slot for a
 * structured message: the fields have to be written as parameters instead.
 */
export const parseMaxiCodeScm = (data: string): MaxiCodeScm | null => {
    const parts = data.split(MAXICODE_GS);
    if (parts.length < 4) return null;
    const [postcode, country, serviceClass] = parts;
    // The body may itself contain separators, so everything after the third
    // field belongs to it.
    return { postcode, country, serviceClass, body: parts.slice(3).join(MAXICODE_GS) };
};
