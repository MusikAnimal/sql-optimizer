# SQL Optimizer

Run EXPLAIN on Wikimedia Toolforge SQL queries

https://tools.wmflabs.org/sql-optimizer

## Report bugs

You can report bugs or make feature requests by filing an issue on GitHub:
https://github.com/MusikAnimal/sql-optimizer/issues

Or you can use on
[Wikimedia's Phabricator](https://phabricator.wikimedia.org/maniphest/task/edit/form/1/?projects=Tools&title=SQL%20Optimizer&description=https://tools.wmflabs.org/sql-optimizer&subscribers=MusikAnimal).
Please tag with the `Tools` project and add `MusikAnimal` as a subscriber.

## Installation

Prerequisites:

* [Node.js](https://nodejs.org/en/) with the version specified by [.nvmrc](.nvmrc).
* [npm](https://www.npmjs.com/)
* A [Wikimedia developer account](https://wikitech.wikimedia.org/wiki/Help:Create_a_Wikimedia_developer_account)
  and access to the [Toolforge environment](https://wikitech.wikimedia.org/wiki/Portal:Toolforge).

Installation:

* `git clone https://github.com/MusikAnimal/sql-optimizer`
* `cd sql-optimizer`
* `npm install`
* Establish an SSH tunnel to the Toolforge replicas.
  It is important to connect to a specific database server.
  The command will be something similar to:

      ssh -L 4711:s1.web.db.svc.eqiad.wmflabs:3306 your-username@login.tools.wmflabs.org

* `cp .env.json.dist .env.json` and fill out the details. In the above example,
  the `db_port` would be `4711`.
* `npm run-script build && npm run-script start` - note you will need to re-run this
  command as you make changes during development.
* You should be up and running at http://localhost:8000/sql-optimizer
