const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'db',
  user: 'wikiuser',
  password: 'wikiuser',
  database: 'my_wiki',
});

Promise.all([
  pool.getConnection(),
  pool.getConnection(),
  pool.getConnection(),
]).then(([queryConnection, explainConnection, killConnection]) => {
  queryConnection.query('SELECT SLEEP(1), page.* FROM page').catch((err) => {
    // Don't know, don't care.
  });
  explainConnection.query(`SHOW EXPLAIN FOR ${queryConnection.connection.threadId}`).then((result) => {
    console.log(result[0][0]);
    process.exit(0);
  });
  // Kill the connection to the first query so the explain can run if we are
  // using the same server thread.
  killConnection.query('KILL CONNECTION ' + queryConnection.connection.threadId);
});
