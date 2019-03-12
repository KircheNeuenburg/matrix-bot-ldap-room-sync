var matrix = require("matrix-js-sdk");
var ldap = require('ldapjs');
var events = require('events');
var config = require('./config.json');

var event_emitter = new events.EventEmitter();

var matrix_client = matrix.createClient({
    baseUrl: 'https://' + config.matrix.domain_homeserver,
});

// Login to matrix with credentials, once logged in, client is startet
matrix_client.loginWithPassword(config.matrix.bot_id, config.matrix.bot_pw, function(err, data) {
    if (err) {
        console.log('matrix login error:', err);
    }
    else { 
        matrix_client.credentials.accessToken = data.access_token;
        matrix_client.credentials.userId = data.user_id;
        // start client after successful login
        matrix_client.startClient();
    }

});

// Autojoin rooms when invited. Not needed
//matrix_client.on("RoomMember.membership", function(event, member) {
//    if (member.membership === "invite" && member.userId === config.matrix.bot_id) {
//        matrix_client.joinRoom(member.roomId).done(function() {
//            console.log("Auto-joined %s", member.roomId);
//        });
//    }
//});

// emit signal, when matrix is ready
matrix_client.on('sync', function() {
    event_emitter.emit('matrix-ready');
});

// kicks user from room, after beeing removed from corresponding  ldap groups
var kick_user_from_rooms = function(user_id,oldRooms, currentRooms) {
    oldRooms.forEach((old_room) => {
        if((currentRooms.indexOf(old_room) <= -1)) {
            matrix_client.resolveRoomAlias(old_room, function(err,res) {
                if(err) {
                    console.log(err);     
                }
                else {
                    matrix_client.kick(res.room_id,user_id,'',function(err){ console.log(err)});
                }
            });
        }
    });
}

// perform the group to room sync
var sync_groups = function(user) {
    let user_id = '@' + user.uid + ':' + config.matrix.domain_homeserver;
    
    // prevents room modifications for bot account, i.e. kicking yourself out of rooms you manage
    if(user_id == config.matrix.bot_id) {
        return;
    } 
    // search filter for objectclass and membership association and custom filter
    const filter = ['(&'];
    filter.push('(objectclass=' + config.ldap.object_class_group + ')');
    filter.push('(' + config.ldap.member_format + '=' + user[config.ldap.member_mapping] + ')');
    filter.push(config.ldap.filter_group);
    filter.push(')');

    const searchOptions = {
        filter: filter.join(''),
        scope: 'sub',
    };

    // Get all groups of user
    let all_ldap_rooms = matrix_client.getRooms();
    let user_ldap_room_ids = [];
    let user_ldap_room_aliases = [];
    let user_ldap_room_aliases_current = [];
    all_ldap_rooms.forEach((ldap_room) => {
        let members_invited = ldap_room.getMembersWithMembership('invite');
        let members_joined = ldap_room.getMembersWithMembership('join');
        let members = members_invited.concat(members_joined);

        members.forEach((member) => {
            if(member.userId == user_id) {
                user_ldap_room_ids.push(ldap_room.roomId);
                let aliases = ldap_room.getAliases();
                //console.log(aliases);
                let room_regex = new RegExp("^#(.*)(" + config.app.room_appendix + ")(.*)$");
                //console.log(room_regex);
                if (room_regex.test(aliases[0])) {
                    //console.log(aliases[0]);
                    user_ldap_room_aliases.push(aliases[0]);
                }
            }
        });
    });
    //console.log(user_ldap_room_ids);
    const ldapRoomNames = [];
    ldap_client.search(config.ldap.base_dn_group, searchOptions, function(err, res) {
        res.on('searchEntry', function(entry) {
            let room_slug = entry.object.cn.replace(/\s+/g, "_");
            ldapRoomNames.push(room_slug);
        });
        res.on('searchReference', function(referral) {
            console.log('referral: ' + referral.uris.join());
        });
        res.on('error', function(err) {
            console.error('error: ' + err.message);
        });
        res.on('end', function(result) {
            if(user.uid == 'dalang') {
                //console.log(ldapRoomNames);
                ldapRoomNames.forEach((room) => {
                    let room_alias_slug = room + config.app.room_appendix;
                    //console.log("Found David");
                    //console.log(room_slug);
                    let complete_room_alias = '#' + room_alias_slug + ':' + config.matrix.domain_homeserver;
                    user_ldap_room_aliases_current.push(complete_room_alias); 
                    if(user_ldap_room_aliases.indexOf(complete_room_alias) <= -1) {
                        matrix_client.resolveRoomAlias(complete_room_alias, function(err,res) {
                            if(err) {
                                matrix_client.createRoom({
                                    room_alias_name: room_alias_slug,
                                    visibility: "private",
                                    name: room
                                    }, function(err, res) {
                                        if(err) {
                                            console.log(err);
                                        }
                                        else {
                                            matrix_client.invite(res.room_id, user_id, function(err) {
                                                console.log(err);
                                            });
                                }});
                            }
                            else {
                                //console.log(res);
                                matrix_client.invite(res.room_id, user_id, function(err) {
                                    console.log(err);
                                });
                        }});
                    }
                });
                //console.log(user_ldap_room_aliases_current);
                if( config.app.kick_enabled) {
                    kick_user_from_rooms(user_id ,user_ldap_room_aliases, user_ldap_room_aliases_current);
                }
            }
        });
    });
}

var ldap_client = ldap.createClient({
    url: "ldap://" + config.ldap.server_address + ':' + config.ldap.server_port 
});

ldap_client.bind(config.ldap.bind_dn, config.ldap.bind_pw, function(err) {
    console.log('ldap bind error:', err);
});

var ldap_lookup = function() {
    console.log('run ldap_lookup');
    var options = {
        filter: '(&(objectClass=' + config.ldap.object_class_user + ')' + config.ldap.filter_user + ')',
        scope: 'sub',
    };
    ldap_client.search(config.ldap.base_dn_user, options, function(err, res) {
        res.on('searchEntry', function(entry) {
            //console.log('entry: ' + JSON.stringify(entry.object));
            sync_groups(entry.object);
            //console.log(entry.object);
        });
        res.on('searchReference', function(referral) {
            console.log('referral: ' + referral.uris.join());
        });
        res.on('error', function(err) {
            console.error('error: ' + err.message);
        });
        res.on('end', function(result) {
            //console.log('status: ' + result.status);
        });
    });
}

// ldap_lookup should run, when matrix client was successfully set up and ready
event_emitter.addListener('matrix-ready', ldap_lookup);

