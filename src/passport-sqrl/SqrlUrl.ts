import * as base64url from 'base64-url';

/**
 * Implements a SQRL URL generator and parser.
 * Based on https://www.grc.com/sqrl/protocol.htm
 * Unit tests are in SqrlUrl.tests.ts.
 */
export class SqrlUrl {
  constructor(url: string) {

  }
}

/**
 * Creates SQRL URLs. The static methods may be used directly, or else an instance
 * of this class may be instantiated with configuration information to reduce
 * the number of parameters a caller has to pass.
 */
export class SqrlUrlFactory {
  /**
   * Creates a SQRL URL from full "nut" metadata.
   * @param secure Whether the server is using TLS, which maps to the 'sqrl://' or 'qrl://' schemes.
   * @param domain The site domain, e.g. "www.foo.com"
   * @param serverNut The opaque, unique server data generated for this URL, passed as the nut= query parameter.
   * @param pathString Optional path string, e.g. "path/to/sqrlLogin". May start with a forward slash.
   * @param domainExtension When positive, specifies the value to place into the x= query parameter that tells the client how many characters of the pathString to include in its server key hash.
   * @param serverFriendlyName Optional server friendly name for display in the SQRL client. When specified, adds the sfn= query parameter.
   */
  public static create(
      secure: boolean,
      domain: string,
      serverNut: string | Buffer,
      pathString?: string,
      domainExtension?: number,
      serverFriendlyName?: string)
      : string {
    let scheme = secure ? 'sqrl' : 'qrl';

    if (!pathString) {
      pathString = '';
    }

    if (pathString.length > 0 && pathString[0] !== '/') {
      pathString = '/' + pathString;
    }

    if (pathString.endsWith('?')) {
      pathString = pathString.substring(0, pathString.length - 1);
    }

    // domainExt includes the starting / of the path; start calculating after pathString has that prefix.
    let domainExt = '';
    if (pathString.length > 0 && domainExtension && domainExtension > 0) {
      domainExtension = Math.min(domainExtension, pathString.length);
      domainExt = `&x=${domainExtension}`;
    }

    let sfn = '';
    if (serverFriendlyName && serverFriendlyName.length > 0) {
      sfn = '&sfn=' + base64url.encode(serverFriendlyName);
    }

    return `${scheme}://${domain}${pathString}?nut=${serverNut}${domainExt}${sfn}`;
  }

  private secure: boolean;
  private domain: string;
  private pathString: string | undefined;
  private serverFriendlyName: string | undefined;
  
  /**
   * Creates a SQRL URL factory with static configuration information.
   * @param secure Whether the server is using TLS, which maps to the 'sqrl://' or 'qrl://' schemes.
   * @param domain The site domain, e.g. "www.foo.com"
   * @param pathString Optional path string, e.g. "path/to/sqrlLogin". May start with a forward slash.
   * @param serverFriendlyName Optional server friendly name for display in the SQRL client. When specified, adds the sfn= query parameter.
   */
  constructor(secure: boolean, domain: string, pathString?: string, serverFriendlyName?: string) {
    this.secure = secure;
    this.domain = domain;
    this.pathString = pathString;
    this.serverFriendlyName = serverFriendlyName;
  }

  /**
   * Creates a SQRL URL from the provided unique server data.
   * @param serverNut The opaque, unique server data generated for this URL, passed as the nut= query parameter.
   * @param pathString Optional path string, e.g. "path/to/sqrlLogin". May start with a forward slash.
   * @param domainExtension When positive, specifies the value to place into the x= query parameter that tells the client how many characters of the pathString to include in its server key hash.
   */
  public create(serverNut: string | Buffer, pathString?: string, domainExtension?: number): string {
    return SqrlUrlFactory.create(this.secure, this.domain, serverNut, pathString || this.pathString, domainExtension, this.serverFriendlyName);
  }
}
