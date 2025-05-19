/*
Copyright (c) 2025 Licensed under the Open Software License version 3.0

OSL-3.0 <https://spdx.org/licenses/OSL-3.0.html>

Attribution Notice:
Skillet (discord: steelskillet)
The Unnamed (https://theunnamedcorp.com/)
*/

import BasePlugin from './base-plugin.js';
import { DataTypes } from 'sequelize';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { readFile, writeFile } from 'node:fs/promises';

export default class OfficialKothDB extends BasePlugin {
  static get description() {
    return "Pushes ServerSettings.json from database on startup and syncs player data on join/leave; ServerSettings sync every 90 seconds only when player count is 50 or more; Tracks player stats (playtime, kills, deaths, captures) for telemetry";
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      kothFolderPath: {
        required: false,
        description: 'Folder path (relative to squadjs index.js) of the koth data folder.',
        default: './SquadGame/Saved/KOTH/'
      },
      database: {
        required: true,
        description: 'Database to use',
        default: false,
        connector: 'sequelize'
      },
      syncEnabled: {
        required: false,
        description: 'Whether periodic sync of ServerSettings.json is enabled.',
        default: true
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.models = {};
    this.playerSessions = {}; // Store login times for playtime tracking

    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
    this.onPlayerKilled = this.onPlayerKilled.bind(this);
    this.onKothCaptured = this.onKothCaptured.bind(this);
  }

  createModel(name, schema) {
    this.models[name] = this.options.database.define(`KOTH_${name}`, schema, { timestamps: false });
  }

  async prepareToMount() {
    const playeridmeta = { 
      type: DataTypes.STRING,
      unique: true
    };

    // PlayerData model
    await this.createModel('PlayerData', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      player_id: playeridmeta,
      lastsave: { type: DataTypes.DATE },
      serversave: { type: DataTypes.INTEGER },
      playerdata: { type: DataTypes.JSON }
    });

    // PlayerStats model for telemetry
    await this.createModel('PlayerStats', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      player_id: {
        type: DataTypes.STRING,
        references: {
          model: 'KOTH_PlayerData',
          key: 'player_id'
        }
      },
      playtime_seconds: { type: DataTypes.INTEGER, defaultValue: 0 },
      kills: { type: DataTypes.INTEGER, defaultValue: 0 },
      deaths: { type: DataTypes.INTEGER, defaultValue: 0 },
      captures: { type: DataTypes.INTEGER, defaultValue: 0 },
      last_updated: { type: DataTypes.DATE }
    });

    try {
      await this.models.PlayerData.sync();
      await this.models.PlayerStats.sync({ alter: true }); // Ensure indexing
      this.verbose(1, 'OfficialKothDB: PlayerData and PlayerStats tables initialized');
    } catch (err) {
      this.verbose(1, `OfficialKothDB: Failed to sync tables: ${err.message}`);
      throw err;
    }
  }

  async readPlayerList() {
    const playerListPath = path.join(this.kothpath, 'PlayerList.json');
    this.verbose(1, `OfficialKothDB: Attempting to read PlayerList.json from ${playerListPath}`);

    if (!fs.existsSync(playerListPath)) {
      this.verbose(1, `OfficialKothDB: PlayerList.json does not exist at ${playerListPath}`);
      return [];
    }

    try {
      const data = await readFile(playerListPath, 'utf8');
      if (!data) {
        this.verbose(1, `OfficialKothDB: PlayerList.json is empty at ${playerListPath}`);
        return [];
      }

      const jsonData = JSON.parse(data);
      const steamIDs = jsonData.players || [];
      if (!Array.isArray(steamIDs)) {
        this.verbose(1, `OfficialKothDB: Invalid format in PlayerList.json: 'players' is not an array`);
        return [];
      }
      this.verbose(1, `OfficialKothDB: Successfully read ${steamIDs.length} steamIDs from PlayerList.json`);
      return steamIDs;
    } catch (err) {
      this.verbose(1, `OfficialKothDB: Error reading or parsing PlayerList.json at ${playerListPath}: ${err.message}`);
      return [];
    }
  }

  async syncServerSettings() {
    try {
      const serverSettings = await this.models.PlayerData.findOne({
        where: { player_id: 'ServerSettings' }
      });
      if (serverSettings) {
        const serverSettingsPath = path.join(this.kothpath, 'ServerSettings.json');
        const serverData = typeof serverSettings.playerdata === 'string' ? JSON.parse(serverSettings.playerdata) : serverSettings.playerdata;
        await writeFile(serverSettingsPath, JSON.stringify(serverData, null, 2));
        this.verbose(1, 'OfficialKothDB: Pushed ServerSettings.json from database');
      } else {
        this.verbose(1, 'OfficialKothDB: No ServerSettings record found in database, skipping push');
      }
    } catch (err) {
      this.verbose(1, `OfficialKothDB: Error syncing ServerSettings: ${err.message}`);
    }
  }

  async getPlayerStatsForTelemetry() {
    try {
      const stats = await this.models.PlayerStats.findAll({
        attributes: ['player_id', 'playtime_seconds', 'kills', 'deaths', 'captures', 'last_updated']
      });
      return stats.map(stat => ({
        player_id: stat.player_id,
        playtime_seconds: stat.playtime_seconds,
        kills: stat.kills,
        deaths: stat.deaths,
        captures: stat.captures,
        last_updated: stat.last_updated
      }));
    } catch (err) {
      this.verbose(1, `OfficialKothDB: Error fetching telemetry stats: ${err.message}`);
      return [];
    }
  }

  async syncKothFiles() {
    try {
      const connectedSteamIDs = await this.readPlayerList();
      if (connectedSteamIDs.length >= 50 && this.options.syncEnabled) {
        await this.syncServerSettings();
      } else {
        this.verbose(1, `OfficialKothDB: Player count (${connectedSteamIDs.length}) below 50 or sync disabled, skipping ServerSettings sync`);
      }

      if (connectedSteamIDs.length === 0) {
        this.verbose(1, 'OfficialKothDB: No connected players found in PlayerList.json');
      }

      for (const steamID of connectedSteamIDs) {
        const playerFilePath = path.join(this.kothpath, `${steamID}.json`);
        this.verbose(1, `OfficialKothDB: Checking player file at ${playerFilePath}`);

        if (fs.existsSync(playerFilePath)) {
          try {
            const playerDataRaw = await readFile(playerFilePath, 'utf8');
            const playerData = JSON.parse(playerDataRaw);

            // Sync PlayerData
            await this.models.PlayerData.upsert({
              player_id: steamID,
              lastsave: new Date(),
              serversave: this.server.id,
              playerdata: playerData
            });

            // Merge stats from player file (if any)
            const fileStats = playerData.stats || {};
            const dbStats = await this.models.PlayerStats.findOne({ where: { player_id: steamID } });
            if (dbStats && fileStats) {
              await this.models.PlayerStats.update({
                kills: dbStats.kills + (fileStats.kills || 0),
                deaths: dbStats.deaths + (fileStats.deaths || 0),
                captures: dbStats.captures + (fileStats.captures || 0),
                last_updated: new Date()
              }, { where: { player_id: steamID } });
            }

            this.verbose(1, `OfficialKothDB: Synced player data and stats for ${steamID}`);
          } catch (err) {
            this.verbose(1, `OfficialKothDB: Error syncing player ${steamID}: ${err.message}`);
          }
        } else {
          this.verbose(1, `OfficialKothDB: Player file for ${steamID} does not exist at ${playerFilePath}`);
        }
      }

      // Log telemetry stats
      const telemetryStats = await this.getPlayerStatsForTelemetry();
      this.verbose(1, `OfficialKothDB: Telemetry stats: ${JSON.stringify(telemetryStats)}`);

      this.verbose(1, 'OfficialKothDB: Periodic sync completed');
    } catch (err) {
      this.verbose(1, `OfficialKothDB: Periodic sync error: ${err.message}`);
    }
  }

  async mount() {
    this.verbose(1, `OfficialKothDB: Current working directory: ${process.cwd()}`);
    this.verbose(1, `OfficialKothDB: Configured kothFolderPath: ${this.options.kothFolderPath}`);

    this.kothpath = path.isAbsolute(this.options.kothFolderPath)
      ? this.options.kothFolderPath
      : path.resolve(process.cwd(), this.options.kothFolderPath);

    this.verbose(1, `OfficialKothDB: Resolved KOTH path: ${this.kothpath}`);

    if (!fs.existsSync(this.kothpath)) {
      try {
        fs.mkdirSync(this.kothpath, { recursive: true });
        this.verbose(1, `OfficialKothDB: Created KOTH directory at ${this.kothpath}`);
      } catch (err) {
        this.verbose(1, `OfficialKothDB: Failed to create KOTH directory at ${this.kothpath}: ${err.message}`);
        this.verbose(1, `OfficialKothDB: KOTH DATA PATH "${this.kothpath}" DOES NOT EXIST. Plugin shall remain dormant!`);
        return;
      }
    }

    const playerListPath = path.join(this.kothpath, 'PlayerList.json');
    if (!fs.existsSync(playerListPath)) {
      this.verbose(1, `OfficialKothDB: PlayerList.json not found at "${playerListPath}". Plugin will not sync player data.`);
    }

    await this.syncServerSettings();
    await this.syncKothFiles();

    if (this.options.syncEnabled) {
      const intervalMs = 90000;
      this.syncInterval = setInterval(() => this.syncKothFiles(), intervalMs);
      this.verbose(1, `OfficialKothDB: Started periodic sync every 90 seconds`);
    } else {
      this.verbose(1, 'OfficialKothDB: Periodic sync disabled');
    }

    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.on('PLAYER_KILLED', this.onPlayerKilled);
    this.server.on('KOTH_CAPTURED', this.onKothCaptured);

    this.verbose(1, `OfficialKothDB: Created hooks`);
  }

  async unmount() {
    this.server.removeEventListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeEventListener('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.removeEventListener('PLAYER_KILLED', this.onPlayerKilled);
    this.server.removeEventListener('KOTH_CAPTURED', this.onKothCaptured);
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.verbose(1, 'OfficialKothDB: Stopped periodic sync');
    }
  }

  getplayerfilename(player) {
    return path.join(this.kothpath, `${player.steamID}.json`);
  }

  async getplayerids(player) {
    return { id: player.steamID };
  }

  async onPlayerConnected(info) {
    this.verbose(1, `OfficialKothDB: koth load`);
    const playerfilename = this.getplayerfilename(info.player);
    this.verbose(1, `OfficialKothDB: attempting to overwrite local data at ${playerfilename}`);

    const playerids = await this.getplayerids(info.player);
    this.verbose(1, `OfficialKothDB: retrieved player id of: ${playerids.id}`);
    if (!playerids) return;

    const playerdb = await this.models.PlayerData.findOne({
      where: { player_id: playerids.id }
    });
    if (playerdb) {
      const playerdata = typeof playerdb.playerdata === 'string' ? JSON.parse(playerdb.playerdata) : playerdb.playerdata;
      fs.writeFileSync(playerfilename, JSON.stringify(playerdata, null, 2));
      this.verbose(1, 'OfficialKothDB: saved file');
    }

    // Initialize stats
    await this.models.PlayerStats.upsert({
      player_id: playerids.id,
      last_updated: new Date()
    });
    this.playerSessions[playerids.id] = { loginTime: new Date() };
    this.verbose(1, `OfficialKothDB: Initialized stats for ${playerids.id}`);
  }

  async onPlayerDisconnected(info) {
    this.verbose(1, `OfficialKothDB: koth save`);
    const playerfilename = this.getplayerfilename(info.player);
    this.verbose(1, `OfficialKothDB: attempting to save file ${playerfilename} to db`);

    const playerids = await this.getplayerids(info.player);
    this.verbose(1, `OfficialKothDB: retrieved player id of: ${playerids.id}`);
    if (!playerids) return;

    if (fs.existsSync(playerfilename)) {
      const playerdataRaw = fs.readFileSync(playerfilename, 'utf8');
      let playerdata;
      try {
        playerdata = JSON.parse(playerdataRaw);
      } catch (err) {
        this.verbose(1, `OfficialKothDB: Invalid JSON in file ${playerfilename}, skipping: ${err.message}`);
        return;
      }
      await this.models.PlayerData.upsert({
        player_id: playerids.id,
        lastsave: new Date(),
        serversave: this.server.id,
        playerdata: playerdata
      });
      this.verbose(1, `OfficialKothDB: saved data to DB`);
    }

    // Update playtime
    const session = this.playerSessions[playerids.id];
    if (session && session.loginTime) {
      const sessionDuration = Math.floor((new Date() - session.loginTime) / 1000);
      const playerStats = await this.models.PlayerStats.findOne({
        where: { player_id: playerids.id }
      });
      if (playerStats) {
        await this.models.PlayerStats.update({
          playtime_seconds: playerStats.playtime_seconds + sessionDuration,
          last_updated: new Date()
        }, { where: { player_id: playerids.id } });
        this.verbose(1, `OfficialKothDB: Updated playtime for ${playerids.id} (+${sessionDuration}s)`);
      }
      delete this.playerSessions[playerids.id];
    }
  }

  async onPlayerKilled(info) {
    const killerId = info.killer?.steamID;
    const victimId = info.victim?.steamID;

    if (killerId) {
      await this.models.PlayerStats.increment('kills', { where: { player_id: killerId } });
      this.verbose(1, `OfficialKothDB: Incremented kills for ${killerId}`);
    }
    if (victimId) {
      await this.models.PlayerStats.increment('deaths', { where: { player_id: victimId } });
      this.verbose(1, `OfficialKothDB: Incremented deaths for ${victimId}`);
    }
  }

  async onKothCaptured(info) {
    const playerId = info.player?.steamID;
    if (playerId) {
      await this.models.PlayerStats.increment('captures', { where: { player_id: playerId } });
      this.verbose(1, `OfficialKothDB: Incremented captures for ${playerId}`);
    }
  }
}
