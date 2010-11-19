/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const DBus = imports.dbus;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const Gettext = imports.gettext.domain('gnome-shell');
const _ = Gettext.gettext;

const BUS_NAME = 'org.gnome.PowerManager';
const OBJECT_PATH = '/org/gnome/PowerManager';

const UPDeviceType = {
    UNKNOWN: 0,
    AC_POWER: 1,
    BATTERY: 2,
    UPS: 3,
    MONITOR: 4,
    MOUSE: 5,
    KEYBOARD: 6,
    PDA: 7,
    PHONE: 8
};

const UPDeviceState = {
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6
};

const PowerManagerInterface = {
    name: 'org.gnome.PowerManager',
    methods: [
        { name: 'GetDevices', inSignature: '', outSignature: 'a(susbut)' },
        { name: 'GetPrimaryDevice', inSignature: '', outSignature: '(susbut)' },
        ],
    signals: [
        { name: 'Changed', outSignature: '' },
        ],
    properties: [
        { name: 'Icon', signature: 's', access: 'read' },
        ]
};
let PowerManagerProxy = DBus.makeProxyClass(PowerManagerInterface);

function Indicator() {
    this._init.apply(this, arguments);
}

Indicator.prototype = {
    __proto__: PanelMenu.SystemStatusButton.prototype,

    _init: function() {
        PanelMenu.SystemStatusButton.prototype._init.call(this, 'battery-missing');
        this._proxy = new PowerManagerProxy(DBus.session, BUS_NAME, OBJECT_PATH);

        this._deviceItems = [ ];
        this._hasPrimary = false;
        this._primaryDeviceId = null;
        this._batteryItem = new PopupMenu.PopupMenuItem('');
        this.menu.addMenuItem(this._batteryItem);
        this._deviceSep = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._deviceSep);
        this._otherDevicePosition = 2;
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_("What's using power..."),function() {
            GLib.spawn_command_line_async('gnome-power-statistics --device wakeups');
        });
        this.menu.addAction(_("Power Settings"),function() {
            GLib.spawn_command_line_async('gnome-control-center power');
        });

        this._proxy.connect('Changed', Lang.bind(this, this._devicesChanged));
        this._devicesChanged();
    },

    _readPrimaryDevice: function() {
        this._proxy.GetPrimaryDeviceRemote(Lang.bind(this, function(device, error) {
            if (error) {
                this._checkError(error);
                this._hasPrimary = false;
                this._primaryDeviceId = null;
                this._batteryItem.actor.hide();
                this._deviceSep.actor.hide();
                return;
            }
            let [device_id, device_type, summary, percentage, state, time] = device;
            if (device_type == UPDeviceType.BATTERY) {
                this._hasPrimary = true;
                this._batteryItem.label.text = summary;
                this._batteryItem.actor.show();
                if (this._deviceItems.length > 0)
                    this._deviceSep.actor.show();
            } else {
                this._hasPrimary = false;
                this._batteryItem.actor.hide();
                this._deviceSep.actor.hide();
            }

            this._primaryDeviceId = device_id;
        }));
    },

    _readOtherDevices: function() {
        this._proxy.GetDevicesRemote(Lang.bind(this, function(devices, error) {
            this._deviceItems.forEach(function(i) { i.destroy(); });
            this._deviceItems = [];

            if (error) {
                this._checkError(error);
                this._deviceSep.actor.hide();
                return;
            }

            let position = 0;
            for (let i = 0; i < devices.length; i++) {
                let [device_id, device_type] = devices[i];
                if (device_type == UPDeviceType.AC_POWER || device_id == this._primaryDeviceId)
                    continue;

                let item = new DeviceItem (devices[i]);
                item.connect('activate', function() {
                    let p = new Shell.Process({ args: ['gnome-power-statistics', '--device', device_id] });
                    p.run();
                });
                this._deviceItems.push(item);
                this.menu.addMenuItem(item, this._otherDevicePosition + position);
                position++;
            }

            if (this._hasPrimary && position > 0)
                this._deviceSep.actor.show();
            else
                this._deviceSep.actor.hide();
        }));
    },

    _devicesChanged: function() {
        this._proxy.GetRemote('Icon', Lang.bind(this, function(icon, error) {
            if (icon) {
                let gicon = Shell.util_icon_from_string (icon);
                this.setGIcon(gicon);
                this.actor.show();
            } else {
                this._checkError(error);
                this.menu.close();
                this.actor.hide();
            }
        }));
        this._readPrimaryDevice();
        this._readOtherDevices();
    },

    _checkError: function(error) {
        if (!this._restarted && error && error.message.match(/org\.freedesktop\.DBus\.Error\.(UnknownMethod|InvalidArgs)/)) {
            GLib.spawn_command_line_sync('pkill -f "^gnome-power-manager$"');
            GLib.spawn_command_line_async('gnome-power-manager');
            this._restarted = true;
        }
    }
};

function DeviceItem() {
    this._init.apply(this, arguments);
}

DeviceItem.prototype = {
    __proto__: PopupMenu.PopupBaseMenuItem.prototype,

    _init: function(device) {
        PopupMenu.PopupBaseMenuItem.prototype._init.call(this);

        let [device_id, device_type, summary, percentage, state, time] = device;

        this._box = new St.BoxLayout({ style_class: 'popup-device-menu-item' });
        this._label = new St.Label({ text: summary });

        let icon;
        switch (state) {
        case UPDeviceState.FULLY_CHARGED:
            icon = 'battery-full-charged';
            break;
        case UPDeviceState.UNKNOWN:
            icon = 'battery-missing';
            break;
        default:
            icon = this._percentageToIcon(percentage) + (state == UPDeviceState.CHARGING ? '-charging' : '');
        }

        this._icon = new St.Icon({ icon_name: icon,
                                   icon_type: St.IconType.SYMBOLIC,
                                   style_class: 'popup-menu-icon' });

        this._box.add_actor(this._icon);
        this._box.add_actor(this._label);
        this.addActor(this._box);

        let percentBin = new St.Bin({ x_align: St.Align.END });
        let percentLabel = new St.Label({ text: '%d%%'.format(Math.round(percentage)) });
        percentBin.child = percentLabel;
        this.addActor(percentBin);
    },

    _percentageToIcon: function(p) {
        if (p > 60)
            return 'battery-full';
        if (p > 30)
            return 'battery-good';
        if (p > 10)
            return 'battery-low';
        if (p > 0)
            return 'battery-caution';
        return 'battery-empty';
    }
}
