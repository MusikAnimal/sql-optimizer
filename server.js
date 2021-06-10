const Hapi = require('hapi');
const mysql = require('mysql2/promise');
const fs = require('fs');
const Vision = require('vision');
const Twig = require('twig');
const env = JSON.parse(fs.readFileSync('env.json', 'utf8'));

// Create a server with a host and port
const server = new Hapi.Server();

// How long the query should SLEEP, in seconds.
const TIMEOUT = 1;

// Param constants.
const TIPS_GENERAL = 'general';
const TIPS_SPECIFIC = 'specific';

server.connection({
    host: env.server_host,
    port: env.server_host === 'localhost' ? env.server_port : process.env.PORT
});

// Static assets.
server.route({
    method: 'GET',
    path: '/application.css',
    handler: (request, h) => {
        return h.file('assets/application.css');
    }
});
server.route({
    method: 'GET',
    path: '/application.js',
    handler: (request, h) => {
        return h.file('assets/application.js');
    }
});
server.route({
    method: 'GET',
    path: '/sql-formatter.min.js',
    handler: (request, h) => {
        return h.file('assets/vendor/sql-formatter.min.js');
    }
});

/********* EXPLAIN ROUTES *********/

function extractUse(sql) {
    const matches = sql.match(/^use\s+(\w+(?:_p)?)\s*\n?;/i);

    if (null === matches) {
        return [sql, null];
    }

    sql = sql.replace(new RegExp(matches[0], 'i'), '');
    return [sql, matches[1]];
}

const getHandler = function (request, h) {
    if (request.query.sql) {
        let [sql, use] = extractUse(request.query.sql);
        use = use || request.query.use || 'enwiki_p';

        return explain(sql, use).then(([queryStatus, results]) => {
            let tips = {};

            if (queryStatus && queryStatus.error) {
                results = queryStatus;
            } else {
                [tips, results] = getTips(sql, results);
            }

            return h.view('index', {
                sql,
                tips,
                use,
                results
            });
        });
    } else {
        return h.view('index');
    }
};

function getUseError(err, database) {
    let error = `USE error: ${err.message}`;

    if (database && database.slice(-2) !== '_p') {
        error += '; Public database names should end with "_p"'
    }

    return { error };
}

function validate(sql) {
    if (/SET.*?max_statement_time\s*=\s*/i.test(sql)) {
        return {error: 'Query error: max_statement_time cannot be set when using this tool.'}
    }

    return false;
}

function injectSleep(sql) {
    // They're SELECTing all rows. Putting SLEEP after the * works in this case.
    if (/^SELECT\s+\*/i.test(sql)) {
        return sql.replace(/\bFROM\b/i, `, SLEEP(${TIMEOUT}) FROM `);
    }

    // Otherwise try the normal injection of SLEEP at the front of the SELECT clause,
    // and for all SELECTs, which is more reliable.
    sql = sql.replace(/\bSELECT\s/gi, `SELECT SLEEP(${TIMEOUT}), `);

    // Remove any SLEEPs that were added to a subquery that used with an IN clause.
    const regex = new RegExp(`IN\\s*\\(\\s*SELECT SLEEP\\(${TIMEOUT}\\),`, 'gi');
    sql = sql.replace(regex, 'IN ( SELECT');

    console.log(sql);
    return sql;
}

async function getExplainConnection(pool, queryInstance) {
    const MAX_RETRIES = 100;

    for (let i = 0; i <= MAX_RETRIES; i++) {
        console.log(`>> CONNECTION RETRY ${i + 1}`);
        const explainConnection = await pool.getConnection();
        const result = await explainConnection.query('SELECT @@GLOBAL.hostname');
        const explainInstance = result[0][0]['@@GLOBAL.hostname'];

        if (explainInstance === queryInstance) {
            console.log(`SUCCESS: Connection to ${explainInstance} established`);
            return explainConnection;
        }

        explainConnection.close();
    }

    return {
        error: `SHOW EXPLAIN failed: Unable to establish a connection after ${MAX_RETRIES} tries.`
    };
}

async function explain(sql, database) {
    let validation = validate(sql);
    if (validation) {
        return new Promise(resolve => resolve([validation, null]));
    }

    const pool = mysql.createPool({
        database: database,
        host: env.db_host.replace('*', database.replace(/_p$/, '')),
        port: env.db_port,
        user: env.db_user,
        password: env.db_password
    });

    const queryConnection = await pool.getConnection();
    return queryConnection.query(`USE ${database}`).then(() => {
        return queryConnection.query('SELECT @@GLOBAL.hostname').then(instanceResult => {
            const instance = instanceResult[0][0]['@@GLOBAL.hostname'];

            return queryConnection.query(`SET max_statement_time = ${TIMEOUT}`).then(() => {
                sql = injectSleep(sql);

                const query = queryConnection.query(sql).then(() => {
                    console.log('SLEEP SUCCESS');
                }).catch(err => {
                    if (![1028, 1969].includes(err.errno)) {
                        console.log(err);
                        return {error: 'Query error: ' + err.message};
                    }
                });

                const explanation = new Promise(resolve => setTimeout(async () => {
                    const explainConnection = await getExplainConnection(pool, instance);
                    const explainPromise = explainConnection.query(`SHOW EXPLAIN FOR ${queryConnection.connection.threadId}`).then(result => {
                        pool.end();
                        return result[0];
                    }).catch(err => {
                        pool.end();
                        return {
                            error: 'SHOW EXPLAIN failed: ' + err.message + ' This may be a connection issue. If you believe your query is valid, try resubmitting.'
                        };
                    });

                    return resolve(explainPromise);
                }, 500));

                return Promise.all([query, explanation]);
            });
        });
    }).catch(err => {
        pool.end();
        return [getUseError(err, database), null];
    });
}

function getTips(sql, explanation) {
    if (!explanation || explanation.error) {
        // Query errored out or query plan unavailable.
        return [{}, explanation];
    }

    let tips = {
        specific: {},
        general: {}
    };

    const pushTip = (index, comment, type = TIPS_GENERAL) => {
        tips[type][index] = tips[type][index] || [];
        if (comment && !tips[type][index].includes(comment)) {
            tips[type][index].push(comment);
        }
    };

    // Tip to use userindexes:
    const userindexMatches = {
        'revision': 'rev_actor',
        'archive': 'ar_actor',
        'logging': 'log_actor',
        'filearchive': 'fa_actor',
        'ipblocks': 'ipb_actor',
        'oldimage': 'oi_actor',
        'recentchanges': 'rc_actor',
    };
    Object.keys(userindexMatches).forEach(table => {
        if (new RegExp(`\\b${table}\\b[^]*\\b${userindexMatches[table]}`, 'i').test(sql)) {
            const comment = `You appear to be querying the <code>${table}</code> table and filtering by user. ` +
                `It may be more efficient to use the <code>${table}_userindex</code> view.`;
            pushTip('0', comment, TIPS_SPECIFIC);
        }
    });

    // Tip to use specialized actor and comment views:
    const specialViews = [
        'filearchive', 'image', 'ipblocks', 'logging', 'oldimage', 'protected_titles', 'recentchanges', 'revision',
    ];
    specialViews.forEach(table => {
        const matches = sql.match(new RegExp(`\\b${table}[^]*(?:\\b(actor|comment))\\b`, 'i'));
        if (matches) {
            const comment = `You appear to be querying <code>${matches[1]}</code> and <code>${table}</code>. ` +
                `If you only care about ${matches[1]}s in the ${table} table, use the ` +
                '<a href="https://wikitech.wikimedia.org/wiki/News/Actor_storage_changes_on_the_Wiki_Replicas#special-views">specialized view</a> ' +
                `<code>${matches[1]}_${table}</code> to avoid unnecessary subqueries.`;
            pushTip('0', comment, TIPS_SPECIFIC);
        }
    });

    if (/\blogging\b[^]*\b(log_namespace|log_title|log_page)/i.test(sql)) {
        pushTip('0', 'You appear to be querying the <code>logging</code> table and filtering by namespace, title or page ID. ' +
            'It may be more efficient to use the <code>logging_logindex</code> view.');
    }

    // Query plan evaluation.
    explanation.forEach((plan, index) => {
        if (/Using filesort|Using temporary/.test(plan.Extra)) {
            const comment = `Query plan ${plan.id}.${index + 1} is using ` +
                '<a target="_blank" href="https://dev.mysql.com/doc/refman/5.7/en/order-by-optimization.html#order-by-filesort">filesort</a> ' +
                'or a <a target="_blank" href="https://dev.mysql.com/doc/refman/8.0/en/internal-temporary-tables.html">temporary table</a>. ' +
                'This is usually an indication of an inefficient query. If you find your query is slow, try taking advantage ' +
                'of available indexes to avoid filesort.';
            pushTip(index, comment, TIPS_GENERAL);
            plan.Extra = plan.Extra.replace(/(Using (filesort|filesort))/, '<span class="text-danger">$1</span>');
        }

        if (plan.rows > 1000000) {
            const comment = `Query plan ${plan.id}.${index + 1} scans over a million rows. Your query could likely be improved, ` +
                `or broken out into multiple queries to improve performance.`;
            pushTip(index, comment, TIPS_GENERAL);
        }
    });

    if (Object.keys(tips.specific).length || Object.keys(tips.general).length) {
        let comment = 'When running potentially slow queries in your application, consider prepending ' +
            '<code>SET STATEMENT max_statement_time = <i>N</i> FOR</code> to ' +
            '<a target="_blank" href="https://wikitech.wikimedia.org/wiki/Help:Toolforge/Database#Query_Limits">automatically kill</a> ' +
            'the query after <i>N</i> seconds.';
        pushTip('*', comment, TIPS_GENERAL);

        if (/revision(?:_userindex)?|logging(?:_logindex)?/i.test(sql)) {
            comment = 'If you only need to query for recent revisions and log actions (within the last 30 days), ' +
                'using <code>recentchanges</code> or <code>recentchanges_userindex</code> might be faster.';
            pushTip('*', comment, TIPS_GENERAL);
        }
    }

    return [tips, explanation];
}

server.route({
    method: 'GET',
    path: '/',
    handler: getHandler
});

/********* DESCRIBE ROUTES *********/

server.route({
    method: 'GET',
    path: '/describe/{database}',
    handler: (request, h) => {
        return showTables(request.params.database).then(results => {
            return h.view('tables', {
                database: request.params.database,
                results: results[0]
            });
        });
    }
});
server.route({
    method: 'GET',
    path: '/describe/{database}/{table}',
    handler: (request, h) => {
        return describeTable(request.params.database, request.params.table).then(results => {
            return h.view('describe', {
                database: request.params.database,
                table: request.params.table,
                results: results[0]
            });
        });
    }
});

function showTables(database) {
    const connection = mysql.createConnection({
        database: 'enwiki_p',
        host: env.db_host,
        port: env.db_port,
        user: env.db_user,
        password: env.db_password
    });

    return connection.then(client => {
        return client.query(`USE ${database}`).then(() => {
            return client.query('SHOW TABLES').then(results => {
                client.end();
                return results;
            });
        }).catch(err => {
            client.end();
            return [getUseError(err, database)];
        });
    });
}

function describeTable(database, table) {
    const connection = mysql.createConnection({
        database: 'enwiki_p',
        host: env.db_host,
        port: env.db_port,
        user: env.db_user,
        password: env.db_password
    });

    return connection.then(client => {
        return client.query(`USE ${database}`).then(() => {
            return client.query(`DESCRIBE ${database}.${table}`).then(results => {
                client.end();
                return results;
            });
        }).catch(err => {
            client.end();
            return [getUseError(err, database)];
        });
    });
}

/********* STARTING THE SERVICE *********/

const provision = async () => {
    await server.register(Vision);
    await server.register(require('inert'));

    server.views({
        engines: {
            twig: {
                compile: (src, options) => {
                    const template = Twig.twig({ id: options.filename, data: src });

                    return context => {
                        return template.render(context);
                    };
                }
            }
        },
        relativeTo: __dirname,
        path: 'templates'
    });

    await server.start();
    console.log('Server running at:', server.info.uri);
};

provision();
