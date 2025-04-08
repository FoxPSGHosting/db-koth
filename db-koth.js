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
import {readdir,stat,readFile} from 'node:fs/promises'

export default class DBKoth extends BasePlugin{
  static get description(){
    return "Saves KOTH data to db and loads it to sync player data across servers";
  }

  static get defaultEnabled(){
    return false;
  }

  static get optionsSpecification(){
    return {
      kothFolderPath:
        {
          required: false,
          description: 'folder path (relative to squadjs index.js) of the koth data folder.',
          default: './SquadGame/Saved/KOTH/'
        },
      database:
        {
          required: false,
          description: 'database to use',
          default: false,
          connector: 'sequelize'
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
    this.models[name] = this.options.database.define(`KOTH_${name}`, schema, {timestamps: false});
  }

  async prepareToMount() {
    const playeridmeta = { type: DataTypes.STRING };
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

    await this.models.PlayerData.sync();
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

    if(!fs.existsSync(this.kothpath)) {
      this.verbose(1, `KOTH DATA PATH "${this.kothpath}" DOES NOT EXIST. plugin shall remain dormant!`);
      return;
    }
    this.verbose(1, `KOTH path exists at ${this.kothpath}`);

    try {
      for (const playerfile of await readdir(this.kothpath)){
        if(!playerfile.endsWith('.json')) continue;
        const fullfilepath = path.join(this.kothpath, playerfile);
        const playerfileid = playerfile.split('.json')[0]
        const playerids = await this.getplayerids({steamID: playerfileid});
        const dbdata = await this.models.PlayerData.findOne({
          where: { player_id: playerids.id}
        });
        const lastfileedit = (await stat(fullfilepath)).mtime;
        if (!dbdata || (lastfileedit > dbdata.lastsave)) {
          const playerdata = await readFile(fullfilepath, {encoding: 'utf8'});
          await this.models.PlayerData.upsert(
            {
              player_id: playerids.id,
                lastsave: new Date(),
              serversave: this.server.id,
              playerdata: JSON.parse(playerdata)
            },
            {
              conflictFields: ['player_id']
            }
          );
          this.verbose(1, `[${playerfileid}] playerfile is newer than db, saved to db`);
        } else {
          fs.writeFile(fullfilepath, JSON.stringify(dbdata.playerdata), (err) => {
            if (err) {this.verbose(1, `[${playerfileid}] failed to write file!`);}
          });
          this.verbose(1, `[${playerfileid}] db is newer than playerfile, writing to playerfile`);
        }
      }
    } catch(err) {
      this.verbose(1, err);
    }

    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);

    this.verbose(1, `created hooks`);
  }

  async unmount() {
    this.server.removeEventListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeEventListener('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
  }

  getplayerfilename(player) {
    return path.join(this.kothpath, `${player.steamID}.json`);
  }

  async getplayerids(player){
    return { id: player.steamID };
  }

  async onPlayerConnected(info) {
    this.verbose(1, `koth load`);
    const playerfilename = this.getplayerfilename(info.player);
    this.verbose(1, `attempting to overwrite local data at ${playerfilename}`);

    const playerids = await this.getplayerids(info.player);
    this.verbose(1, `retrieved player id of: ${playerids.id}`);
    if(!playerids) return;
    const playerdb = await this.models.PlayerData.findOne({
      where: {player_id: playerids.id}
    });
    if(!playerdb) return;
    this.verbose(1, `found playerdata in DB and read into memory`);
    fs.writeFileSync(playerfilename, JSON.stringify(playerdb.playerdata));
    this.verbose(1, `saved file`);
  }

  async onPlayerDisconnected(info) {
    this.verbose(1, `koth save`);
    const playerfilename = this.getplayerfilename(info.player);
    this.verbose(1, `attempting to save file ${playerfilename} to db`);
    if(!fs.existsSync(playerfilename)) return;
    const playerdata = JSON.parse(fs.readFileSync(playerfilename));
    this.verbose(1,`read player data into memory`);

    const playerids = await this.getplayerids(info.player);
    this.verbose(1, `retrieved player id of: ${playerids.id}`);
    if(!playerids) return;
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
