/*
Copyright (c) 2025 Licensed under the Open Software License version 3.0

OSL-3.0 <https://spdx.org/licenses/OSL-3.0.html>

Attribution Notice:
Skillet (discord: steelskillet)
The Unnamed (https://theunnamedcorp.com/)
*/

/*
OSL basic permissions:
distribution or modification are allowed for any purpose provided that you:
1. license the work under this same license (section 1(c))
2. include a copy of the above copyright notice and Attribution Notice in ANY derivatives or copies (section 6)
 a. you may exclude this 'OSL basic permissions' part.
3. provide access to the source code for private copies or derivatives if it has public network access (section 5)
4. provide reasonable notice under 'Attribution Notice' that you have modified this work (section 6)
*/

import BasePlugin from './base-plugin.js';
import { DataTypes } from 'sequelize';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises'

export default class DBKoth extends BasePlugin {
  static get description(){
    return "Saves KOTH data to db and loads it to sync player data across servers";
  }

  static get defaultEnabled(){
    return false;
  }

  static get optionsSpecification(){
    return {
      kothFolderPath: {
        required: false,
        description: 'folder path (relative to squadjs index.js) of the koth data folder.',
        default: './SquadGame/Saved/KOTH/'
      },
      database: {
        required: true,
        description: 'database to use',
        default: false,
        connector: 'sequelize'
      },
      syncInterval: {
        required: false,
        description: 'Interval for periodic sync in seconds.',
        default: 60
      },
      syncEnabled: {
        required: false,
        description: 'Whether periodic sync is enabled.',
        default: true
      }
    }
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.models = {};

    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
  }

  createModel(name, schema) {
    this.models[name] = this.options.database.define(`KOTH_${name}`, schema, { timestamps: false });
  }

  async prepareToMount() {
    const playeridmeta = { 
      type: DataTypes.STRING,
      unique: true
    };
    await this.createModel('PlayerData', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      player_id: playeridmeta,
      lastsave: {
        type: DataTypes.DATE
      },
      serversave: {
        type: DataTypes.INTEGER
      },
      playerdata: {
        type: DataTypes.JSON
      }
    });

    try {
      await this.models.PlayerData.sync();
      this.verbose(1, 'DBKoth: PlayerData table initialized');
    } catch (err) {
      this.verbose(1, `DBKoth: Failed to sync PlayerData table: ${err.message}`);
      throw err;
    }
  }

  async syncKothFiles() {
    try {
      // Sync folder files to database
      const files = await readdir(this.kothpath);
      const processedSteamIDs = new Set();

      for (const playerfile of files) {
        if (!playerfile.endsWith('.json') || playerfile === 'ServerSettings.json' || playerfile.toLowerCase() === 'serversettings.json') {
          if (playerfile === 'ServerSettings.json' || playerfile.toLowerCase() === 'serversettings.json') {
            this.verbose(1, `[${playerfile}] Skipped ServerSettings.json`);
          }
          continue;
        }
        const fullfilepath = path.join(this.kothpath, playerfile);
        const playerfileid = playerfile.split('.json')[0];
        processedSteamIDs.add(playerfileid);
        const playerids = await this.getplayerids({ steamID: playerfileid });
        const dbdata = await this.models.PlayerData.findOne({
          where: { player_id: playerids.id }
        });
        const lastfileedit = (await stat(fullfilepath)).mtime;
        if (!dbdata || (lastfileedit > dbdata.lastsave)) {
          const playerdataRaw = await readFile(fullfilepath, { encoding: 'utf8' });
          let playerdata;
          try {
            playerdata = JSON.parse(playerdataRaw);
          } catch (err) {
            this.verbose(1, `[${playerfileid}] Invalid JSON in file, skipping: ${err.message}`);
            continue;
          }
          await this.models.PlayerData.upsert(
            {
              player_id: playerids.id,
              lastsave: new Date(),
              serversave: this.server.id,
              playerdata: playerdata
            },
            {
              conflictFields: ['player_id']
            }
          );
          this.verbose(1, `[${playerfileid}] playerfile is newer than db, saved to db`);
        } else if (dbdata) {
          const playerdata = typeof dbdata.playerdata === 'string' ? JSON.parse(dbdata.playerdata) : dbdata.playerdata;
          await writeFile(fullfilepath, JSON.stringify(playerdata, null, 2));
          this.verbose(1, `[${playerfileid}] db is newer than playerfile, writing to playerfile`);
        }
      }

      // Check database for player data without JSON files
      const dbPlayers = await this.models.PlayerData.findAll({
        attributes: ['player_id', 'lastsave', 'playerdata']
      });
      for (const dbPlayer of dbPlayers) {
        const steamID = dbPlayer.player_id;
        // Skip invalid player_id entries (non-SteamID or ServerSettings)
        if (!/^\d{17}$/.test(steamID) || steamID.toLowerCase() === 'serversettings') {
          this.verbose(1, `[${steamID}] Skipped invalid player_id in database`);
          continue;
        }
        if (!processedSteamIDs.has(steamID)) {
          const playerfilename = path.join(this.kothpath, `${steamID}.json`);
          const playerdata = typeof dbPlayer.playerdata === 'string' ? JSON.parse(dbPlayer.playerdata) : dbPlayer.playerdata;
          await writeFile(playerfilename, JSON.stringify(playerdata, null, 2));
          this.verbose(1, `[${steamID}] no JSON file, created from db`);
        }
      }

      this.verbose(1, 'DBKoth: Periodic sync completed');
    } catch (err) {
      this.verbose(1, `DBKoth: Periodic sync error: ${err.message}`);
    }
  }

  async mount() {
    const modpath = fileURLToPath(import.meta.url);
    this.kothpath = path.join(
      modpath,
      '..',
      '..',
      '..',
      this.options.kothFolderPath
    );

    if (!fs.existsSync(this.kothpath)) {
      this.verbose(1, `KOTH DATA PATH "${this.kothpath}" DOES NOT EXIST. plugin shall remain dormant!`);
      return;
    }
    this.verbose(1, `KOTH path exists at ${this.kothpath}`);

    await this.syncKothFiles(); // Initial sync

    // Start periodic sync if enabled
    if (this.options.syncEnabled) {
      const intervalMs = this.options.syncInterval * 1000; // Convert seconds to milliseconds
      this.syncInterval = setInterval(() => this.syncKothFiles(), intervalMs);
      this.verbose(1, `DBKoth: Started periodic sync every ${this.options.syncInterval} seconds`);
    } else {
      this.verbose(1, 'DBKoth: Periodic sync disabled');
    }

    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);

    this.verbose(1, `created hooks`);
  }

  async unmount() {
    this.server.removeEventListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeEventListener('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.verbose(1, 'DBKoth: Stopped periodic sync');
    }
  }

  getplayerfilename(player) {
    return path.join(this.kothpath, `${player.steamID}.json`);
  }

  async getplayerids(player) {
    return { id: player.steamID };
  }

  async onPlayerConnected(info) {
    this.verbose(1, `koth load`);
    const playerfilename = this.getplayerfilename(info.player);
    this.verbose(1, `attempting to overwrite local data at ${playerfilename}`);

    const playerids = await this.getplayerids(info.player);
    this.verbose(1, `retrieved player id of: ${playerids.id}`);
    if (!playerids) return;
    const playerdb = await this.models.PlayerData.findOne({
      where: { player_id: playerids.id }
    });
    if (!playerdb) return;
    this.verbose(1, `found playerdata in DB and read into memory`);
    const playerdata = typeof playerdb.playerdata === 'string' ? JSON.parse(playerdb.playerdata) : playerdb.playerdata;
    fs.writeFileSync(playerfilename, JSON.stringify(playerdata, null, 2));
    this.verbose(1, `saved file`);
  }

  async onPlayerDisconnected(info) {
    this.verbose(1, `koth save`);
    const playerfilename = this.getplayerfilename(info.player);
    this.verbose(1, `attempting to save file ${playerfilename} to db`);
    if (!fs.existsSync(playerfilename)) return;
    const playerdataRaw = fs.readFileSync(playerfilename, 'utf8');
    let playerdata;
    try {
      playerdata = JSON.parse(playerdataRaw);
    } catch (err) {
      this.verbose(1, `Invalid JSON in file ${playerfilename}, skipping: ${err.message}`);
      return;
    }
    this.verbose(1, `read player data into memory`);

    const playerids = await this.getplayerids(info.player);
    this.verbose(1, `retrieved player id of: ${playerids.id}`);
    if (!playerids) return;
    await this.models.PlayerData.upsert(
      {
        player_id: playerids.id,
        lastsave: new Date(),
        serversave: this.server.id,
        playerdata: playerdata
      },
      {
        conflictFields: ['player_id']
      }
    );
    this.verbose(1, `saved data to DB`);
  }
}
