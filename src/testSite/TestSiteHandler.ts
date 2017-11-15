// Module containing web site logic for the test site.
//
// URI space and site design notes
//
// Browser session cookies have been enabled for tracking the user
// session once logged in. The back-end database is an in-memory NeDB
// (https://github.com/louischatriot/nedb/) instance. The user
// profile schema information is in UserDBRecord.
//
// Browser page URI space:
//   / : Home page, hosted from index.ejs (template)
//   /login : GET for login page (login.ejs)
//   /sqrlLogin : GET/POST API endpoint for SQRL login

import * as bodyParser from 'body-parser';
import * as cookieParser from 'cookie-parser';
import * as ejs from 'ejs';
import * as express from 'express';
import * as expressLayouts from 'express-ejs-layouts';
import * as expressSession from 'express-session';
import * as fs from 'fs';
import * as neDB from 'nedb';
import * as os from 'os';
import * as passport from 'passport';
import * as path from 'path';
import * as qr from 'qr-image';
import * as favicon from 'serve-favicon';
import * as spdy from 'spdy';
import { promisify } from 'util';
import { AuthCompletionInfo, ClientRequestInfo, ILogger, ISQRLIdentityStorage, NutInfo, SQRLExpress, SQRLStrategy, SQRLStrategyConfig, TIFFlags, UrlAndNut } from '../passport-sqrl';

// TypeScript definitions for SPDY do not include an overload that allows the common
// Express app pattern as a param. Inject an overload to avoid compilation errors.
declare module 'spdy' {
  namespace server {
    export function create(options: ServerOptions, handler: express.Application): Server;
  }
}

// Promisify extensions.
declare module 'nedb' {
  class Nedb {
    public findOneAsync(query: any): Promise<any>;
    public insertAsync(newDoc: any): Promise<any>;
    public updateAsync(query: any, updateQuery: any, options?: Nedb.UpdateOptions): Promise<number>;
  }
}
(<any> neDB).prototype.findOneAsync = promisify(neDB.prototype.findOne);
(<any> neDB).prototype.insertAsync = promisify(neDB.prototype.insert);
(<any> neDB).prototype.updateAsync = promisify(neDB.prototype.update);

const serverTlsCertDir = __dirname;
const serverTlsKey = serverTlsCertDir + "/TestSite.PrivateKey.pem";
const serverTlsCert = serverTlsCertDir + "/TestSite.Cert.pem";

export class TestSiteHandler implements ISQRLIdentityStorage {
  private testSiteServer: spdy.Server;
  private sqrlPassportStrategy: SQRLStrategy;
  private sqrlApiHandler: SQRLExpress;
  private userTable: neDB;
  private nutTable: neDB;
  private log: ILogger;

  constructor(log: ILogger, port: number = 5858, domainName: string | null = null) {
    this.log = log;
    let webSiteDir = path.join(__dirname, 'WebSite');
    const sqrlApiRoute = '/sqrl';
    const loginPageRoute = '/login';
    const pollNutRoute = '/pollNut/:nut';
    const loginSuccessRedirect = '/';

    this.userTable = new neDB(<neDB.DataStoreOptions> { inMemoryOnly: true });
    this.nutTable = new neDB(<neDB.DataStoreOptions> { inMemoryOnly: true });

    let sqrlConfig = <SQRLStrategyConfig> {
      localDomainName: domainName || this.getLocalIPAddresses()[0],
      port: port,
      urlPath: sqrlApiRoute,
    };

    // The SQRL API needs its own dedicated API endpoint. SQRLExpress
    // handles this API for us.
    this.sqrlApiHandler = new SQRLExpress(this, this.log, sqrlConfig);

    // Configure PassportJS with the SQRL Strategy. PassportJS will add the
    // implicit res.login() method used later on. We use the SQRL primary
    // public key as the key for the identity.
    this.sqrlPassportStrategy = new SQRLStrategy(this.log, sqrlConfig);
    passport.use(this.sqrlPassportStrategy);
    passport.serializeUser((user: UserDBRecord, done) => done(null, user.sqrlPrimaryIdentityPublicKey));
    passport.deserializeUser((id: any, done: (err: Error, doc: any) => void) => this.findUser(id, done));

    // Useful: http://toon.io/understanding-passportjs-authentication-flow/
    const app = express()
      // ----------------------------------------------------------------------
      // Layout and default parsers
      // ----------------------------------------------------------------------
      .set('view engine', 'ejs')
      .set('views', path.join(__dirname, 'views'))
      .use(expressLayouts)
      .use(favicon(webSiteDir + '/favicon.ico'))  // Early to handle quickly without passing through other middleware layers
      .use(cookieParser())
      .use(bodyParser.urlencoded({extended: true}))  // Needed for parsing bodies (login)

      // ----------------------------------------------------------------------
      // Session: We use sessions for ambient cookie-based login.
      // NOTE: If you're copying this for use in your own site, you need to
      // replace the secret below with a secret deployed securely.
      // ----------------------------------------------------------------------
      .use(expressSession({  // Session load+decrypt support, must come before passport.session
        secret: 'SQRL-Test',  // SECURITY: If reusing site code, you need to supply this secret from a real secret store.
        resave: true,
        saveUninitialized: true
      }))
      .use(passport.initialize())
      .use(passport.session())

      // ----------------------------------------------------------------------
      // The /login route displays a SQRL QR code.
      // ----------------------------------------------------------------------
      .get(loginPageRoute, (req, res) => {
        this.log.debug('/login requested');
        let urlAndNut: UrlAndNut = this.sqrlApiHandler.getSqrlUrl(req);
        this.nutIssuedToClientAsync(urlAndNut)
          .then(() => {
            let qrSvg = qr.imageSync(urlAndNut.url, { type: 'svg', parse_url: true });
            res.render('login', {
              subpageName: 'Log In',
              sqrlUrl: urlAndNut.url,
              sqrlNut: urlAndNut.nutString,
              sqrlQR: qrSvg
            });
          });
      })

      // ----------------------------------------------------------------------
      // The SQRL API and login sequence does not use the HTTP Authenticate
      // header, but instead acts as a distinct API surface area. We use a
      // dedicated route just for handing its API calls, and use back-end
      // storage mechanisms to complete the login on the user's behalf.
      // ----------------------------------------------------------------------
      .post(sqrlApiRoute, this.sqrlApiHandler.handleSqrlApi)
      
      // ----------------------------------------------------------------------
      // Used by login.ejs
      // ----------------------------------------------------------------------
      .get(pollNutRoute, (req, res) => {
        if (req.params.nut) {
          this.getNutRecordAsync(req.params.nut)
            .then(nutRecord => {
              if (!nutRecord) {
                this.log.debug(`pollNut: ${req.params.nut}: No nut record, returning 404`);
                res.statusCode = 404;
                res.end();
              } else if (!nutRecord.loggedIn || !nutRecord.clientPrimaryIdentityPublicKey) {
                this.log.finest(() => `pollNut: ${req.params.nut}: Nut not logged in`);
                res.send(<NutPollResult> { loggedIn: false });
              } else {
                this.findUser(nutRecord.clientPrimaryIdentityPublicKey, (err: Error, userDBRecord: UserDBRecord | null) => {
                  if (err) {
                    this.log.debug(`pollNut: ${req.params.nut}: Error finding user: ${err}`);
                    res.statusCode = 500;
                    res.send(err.toString());
                  } else {
                    this.log.debug(`pollNut: ${req.params.nut}: Nut logged in, logging user in via PassportJS`);
                    // Ensure the cookie header for the response is set the way Passport normally does it.
                    req.login(userDBRecord, loginErr => {
                      if (loginErr) {
                        this.log.debug(`pollNut: ${req.params.nut}: PassportJS login failed: ${loginErr}`);
                        res.statusCode = 400;
                        res.send(loginErr.toString());
                      } else {
                        res.send(<NutPollResult> {
                          loggedIn: nutRecord.loggedIn,
                          redirectTo: loginSuccessRedirect
                        });
                      }
                    });
                  }
                });
              }
            })
            .catch(reason => {
              res.statusCode = 400;
              res.send(reason);
            });
        } else {
          res.statusCode = 404;
          res.end();
        }
      })

      // ----------------------------------------------------------------------
      // Main page. Redirects to /login if there is no logged-in user
      // via the client cookie. Otherwise, relies on the implicit PassportJS
      // user record lookup configured above.
      // ----------------------------------------------------------------------
      .get('/', (req, res) => {
        this.log.debug('/ requested');
        if (!req.user) {
          res.redirect(loginPageRoute);
        } else {
          res.render('index', {
            subpageName: 'Main',
            username: req.user.name,
            sqrlPublicKey: req.user.sqrlPrimaryIdentityPublicKey
          });
        }
      })
      .use(express.static(webSiteDir));  // Serve static scripts and assets. Must come after non-file (e.g. templates, REST) middleware

    // SQRL requires HTTPS so we use SPDY which happily gives us HTTP/2 at the same time.
    // Node 8.6+ contains a native HTTP/2 module we can move to over time.
    this.testSiteServer = spdy.server.create(<spdy.server.ServerOptions> {
      // Leaf cert PEM files for server certificate. See CreateLeaf.cmd and related scripts.
      cert: fs.readFileSync(serverTlsCert),
      key: fs.readFileSync(serverTlsKey),

      // SPDY-specific options
      spdy: {
        plain: false,
        connection: {
          windowSize: 1024 * 1024,
        },
        protocols: ['h2', 'http/1.1'],
      },
    }, app);
    log.info(`Test server listening on ${sqrlConfig.localDomainName}:${port}`);
    this.testSiteServer.listen(port, sqrlConfig.localDomainName);
  }

  public close(): void {
    this.testSiteServer.close();
  }

  // See doc comments on ISQRLIdentityStorage.nutIssuedToClientAsync().
  public async nutIssuedToClientAsync(urlAndNut: UrlAndNut, originalLoginNut?: string): Promise<void> {
    return (<any> this.nutTable).insertAsync(new NutDBRecord(urlAndNut.nutString, urlAndNut.url, originalLoginNut));
  }

  public async getNutInfoAsync(nut: string): Promise<NutInfo | null> {
    return this.getNutRecordAsync(nut);  // NutDBRecord derives from NutInfo.
  }

  public async query(clientRequestInfo: ClientRequestInfo): Promise<AuthCompletionInfo> {
    // SQRL query. We don't create any new user records, just return whether we know about the user.
    let authInfo: AuthCompletionInfo = await this.findUserByEitherKey(clientRequestInfo);
    if (authInfo.user && clientRequestInfo.returnSessionUnlockKey) {
      let user = <UserDBRecord> authInfo.user;
      authInfo.sessionUnlockKey = user.sqrlServerUnlockPublicKey;
    }
    return authInfo;
  }

  public async ident(clientRequestInfo: ClientRequestInfo, nutInfo: NutInfo): Promise<AuthCompletionInfo> {
    // SQRL login request.
    let authInfo: AuthCompletionInfo = await this.findUserByEitherKey(clientRequestInfo);
    if (authInfo.user) {
      // tslint:disable-next-line:no-bitwise
      if (authInfo.tifValues & TIFFlags.PreviousIDMatch) {
        // The user has specified a new primary key, rearrange the record and update.
        let user = authInfo.user;
        if (!user.sqrlPreviousIdentityPublicKeys) {
          user.sqrlPreviousIdentityPublicKeys = [];
        }
        user.sqrlPreviousIdentityPublicKeys.push(clientRequestInfo.previousIdentityPublicKey);  // TODO: Dedup
        user.sqrlPrimaryIdentityPublicKey = clientRequestInfo.primaryIdentityPublicKey;
        let searchRecord = <UserDBRecord> {
          sqrlPrimaryIdentityPublicKey: clientRequestInfo.previousIdentityPublicKey
        };
        authInfo.user = await (<any> this.userTable).updateAsync(searchRecord, user);
      }
    } else {
      // Didn't already exist, create an initial version.
      let newRecord = UserDBRecord.newFromClientRequestInfo(clientRequestInfo);
      let result: UserDBRecord = await (<any> this.userTable).insertAsync(newRecord);
      authInfo.user = result;
      authInfo.tifValues = 0;
    }

    // Update the nut record for the original SQRL URL, which may be getting polled by the /pollNut
    // route right now, with a reference to the user record.
    let originalNutRecord: NutDBRecord | null = <NutDBRecord> nutInfo;  // Full info was returned from our query
    if (originalNutRecord.originalLoginNut) {
      // We have a later nut record, find the original.
      originalNutRecord = await this.getNutRecordAsync(originalNutRecord.originalLoginNut);
    }
    if (originalNutRecord) {  // May have become null when trying to find the original if it was timed out from storage
      originalNutRecord.loggedIn = true;
      originalNutRecord.clientPrimaryIdentityPublicKey = (<UserDBRecord> authInfo.user).sqrlPrimaryIdentityPublicKey;
      await (<any> this.nutTable).updateAsync({ nut: originalNutRecord.nut }, originalNutRecord);
    }
    return authInfo;
  }

  public disable(clientRequestInfo: ClientRequestInfo): Promise<AuthCompletionInfo> {
    // SQRL identity disable request.
    return Promise.resolve(new AuthCompletionInfo());  // TODO
  }

  public enable(clientRequestInfo: ClientRequestInfo): Promise<AuthCompletionInfo> {
    // SQRL identity enable request.
    return Promise.resolve(new AuthCompletionInfo());  // TODO
  }

  public remove(clientRequestInfo: ClientRequestInfo): Promise<AuthCompletionInfo> {
    // SQRL identity remove request.
    return Promise.resolve(new AuthCompletionInfo());  // TODO
  }

  private async getNutRecordAsync(nut: string): Promise<NutDBRecord | null> {
    let searchRecord = { nut: nut };
    let nutRecord: NutDBRecord | null = await (<any> this.nutTable).findOneAsync(searchRecord);
    return nutRecord;
  }

  private findUser(sqrlPublicKey: string, done: (err: Error, doc: any) => void): void {
    // Treat the SQRL client's public key as a primary search key in the database.
    let userDBRecord = <UserDBRecord> {
      sqrlPrimaryIdentityPublicKey: sqrlPublicKey,
    };
    this.userTable.findOne(userDBRecord, done);
  }

  private async findUserByEitherKey(clientRequestInfo: ClientRequestInfo): Promise<AuthCompletionInfo> {
    let result = new AuthCompletionInfo();

    // Search for both keys simultaneously if the previous key is specified.
    let keyMatches = [
      { sqrlPrimaryIdentityPublicKey: clientRequestInfo.primaryIdentityPublicKey }
    ];
    if (clientRequestInfo.previousIdentityPublicKey) {
      keyMatches.push({ sqrlPrimaryIdentityPublicKey: clientRequestInfo.previousIdentityPublicKey });
    }
    let searchRecord = { $or: keyMatches };

    let doc: UserDBRecord = await (<any> this.userTable).findOneAsync(searchRecord);
    if (doc != null) {
      result.user = doc;
      if (doc.sqrlPrimaryIdentityPublicKey === clientRequestInfo.primaryIdentityPublicKey) {
        // tslint:disable-next-line:no-bitwise
        result.tifValues |= TIFFlags.CurrentIDMatch;
      } else {
        // tslint:disable-next-line:no-bitwise
        result.tifValues |= TIFFlags.PreviousIDMatch;
      }
    }
    return result;
  }

  private async findAndUpdateOrCreateUser(clientRequestInfo: ClientRequestInfo): Promise<AuthCompletionInfo> {
    // Treat the SQRL client's public key as a primary search key in the database.
    let searchRecord = <UserDBRecord> {
      sqrlPrimaryIdentityPublicKey: clientRequestInfo.primaryIdentityPublicKey,
    };
    let result = await (<any> this.userTable).findOneAsync(searchRecord);
    if (result == null) {
      // Not found by primary key. Maybe this is an identity change situation.
      // If a previous key was provided, search again.
      if (clientRequestInfo.previousIdentityPublicKey) {
        searchRecord.sqrlPrimaryIdentityPublicKey = clientRequestInfo.previousIdentityPublicKey;
        let prevKeyDoc: UserDBRecord = await (<any> this.userTable).findOneAsync(searchRecord);
        if (prevKeyDoc == null) {
          // Didn't already exist, create an initial version if this is a login API request.
          if (clientRequestInfo.sqrlCommand === 'ident') {
            let newRecord = UserDBRecord.newFromClientRequestInfo(clientRequestInfo);
            result = await (<any> this.userTable).insertAsync(newRecord);
          }
        } else {
          // The user has specified a new primary key, rearrange the record and update.
          if (!prevKeyDoc.sqrlPreviousIdentityPublicKeys) {
            prevKeyDoc.sqrlPreviousIdentityPublicKeys = [];
          }
          prevKeyDoc.sqrlPreviousIdentityPublicKeys.push(clientRequestInfo.previousIdentityPublicKey);
          prevKeyDoc.sqrlPrimaryIdentityPublicKey = clientRequestInfo.primaryIdentityPublicKey;
          await (<any> this.userTable).updateAsync(searchRecord, prevKeyDoc);
          result = prevKeyDoc;
        }
      }
    }
    let authInfo = new AuthCompletionInfo();
    authInfo.user = result;
    return authInfo;
  }

  private getLocalIPAddresses(): string[] {
    let interfaces = os.networkInterfaces();
    let addresses: string[] = [];
    // tslint:disable-next-line:forin
    for (let k in interfaces) {
      // tslint:disable-next-line:forin
      for (let k2 in interfaces[k]) {
        let address = interfaces[k][k2];
        if (address.family === 'IPv4' && !address.internal) {
          addresses.push(address.address);
        }
      }
    }
    return addresses;
  }
}

/**
 * A class modeling a user document in the database.
 * Mostly copies of ClientRequestInfo scalar fields.
 * If we're using something like MongoDB or, in our case, NeDB, we could
 * place these fields under a sub-object called, perhaps, 'sqrl',
 * we instead model the fields as a mostly-flat array of scalars
 * (except the sqrlPreviousIdentityPublicKeys which could be
 * denormalized into 4 individual fields and managed as a 4-entry array),
 * using the 'sqrl' prefix to differentiate from any other user fields
 * for the app.
 */
class UserDBRecord {
  public static newFromClientRequestInfo(clientRequestInfo: ClientRequestInfo): UserDBRecord {
    let result = <UserDBRecord> {
      sqrlPrimaryIdentityPublicKey: clientRequestInfo.primaryIdentityPublicKey,
      sqrlPreviousIdentityPublicKeys: [],
      sqrlServerUnlockPublicKey: clientRequestInfo.serverUnlockPublicKey,
      sqrlServerVerifyUnlockPublicKey: clientRequestInfo.serverVerifyUnlockPublicKey,
      sqrlUseSqrlIdentityOnly: clientRequestInfo.useSqrlIdentityOnly,
      sqrlHardLockSqrlUse: clientRequestInfo.hardLockSqrlUse
    };

    if (clientRequestInfo.previousIdentityPublicKey) {
      result.sqrlPreviousIdentityPublicKeys.push(clientRequestInfo.previousIdentityPublicKey);
    }

    return result;
  }

  // _id is implicit from NeDB.
  // tslint:disable-next-line
  public _id?: string;
  
  /** User name. Could be filled in from any login form submitted from the client. */
  public name?: string;

  /**
   * The current primary identity key. This is a primary search term and would
   * make sense to place into a database index.
   */
  public sqrlPrimaryIdentityPublicKey: string;

  /** Up to four previously seen previous identity keys, for reference. */
  public sqrlPreviousIdentityPublicKeys: string[] = [];
  
  /** The client-provided identity unlock public key, which the client can query to form an identoty change key. */
  public sqrlServerUnlockPublicKey: string;

  /** A client-provided validation key for validating an identity unlock. */
  public sqrlServerVerifyUnlockPublicKey: string;

  /** Client has requested that this site only use its SQRL identity and not any alternate credentials. */
  public sqrlUseSqrlIdentityOnly: boolean = false;

  /**
   * Client has requested that this site disable identity recovery methods like security questions,
   * in favor solely of SQRL related identity recovery.
   */
  public sqrlHardLockSqrlUse: boolean = false;
}

class NutDBRecord extends NutInfo {
  // _id is implicit from NeDB.
  // tslint:disable-next-line
  public _id?: string;

  /** The URL containing the nut. */
  public url?: string;

  /** When the nut was created, for sweeping old entries. */
  public createdAt: Date;

  /** Whether the nut was successfully logged in. Updated on login. */
  public loggedIn: boolean;

  /** The primary public key of a user if a successful login was recorded for this nut. */
  public clientPrimaryIdentityPublicKey?: string;

  constructor(nut: string, url?: string, originalLoginNut?: string) {
    super();
    this.nut = nut;
    this.url = url;
    this.originalLoginNut = originalLoginNut;
    this.createdAt = new Date();
  }
}

/** Returned from /pollNut call. login.ejs makes use of this along with the cookie header. */
class NutPollResult {
  public loggedIn: boolean;
  public redirectTo?: string;
}
