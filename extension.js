import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';
import GLib from 'gi://GLib';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import Clutter from 'gi://Clutter';

import { SaturationEffect } from './glslEffect.js';
import { MAX_MONITORS_SUPPORTED } from './monitors.js';

export default class SaturationExtension extends Extension {
    _settings = null;
    _effect = null;
    _monitorManager = null;
    _monitorCount = 0;
    _settingsChangedId = 0;
    _monitorChangedId = 0;
    _indicator = null;
    _sliderItem = null; // PopupBaseMenuItem wrapper
    _slider = null;     // Slider.Slider widget
    _ignoreSlider = false;
    _active = true;
    _switchItem = null;
    _titleItem = null;
    _markItem = null;

    enable() {
        this._settings = this.getSettings();
        this._monitorManager = global.backend.get_monitor_manager();

        this._effect = new SaturationEffect();

        Main.layoutManager.uiGroup.add_effect(this._effect);
        Main.layoutManager.uiGroup.connect('destroy', () => (this._effect = null));

        // Ensure effect applies over fullscreen windows
        if (Meta.disable_unredirect_for_display) {
            Meta.disable_unredirect_for_display(global.display);
        } else {
            global.compositor.disable_unredirect();
        }

        this._settingsChangedId = this._settings.connect('changed', ((_, key) => {
            this._syncSettings(key);
            this._syncIndicatorFromSettings();
        }));
        this._monitorChangedId = Main.layoutManager.connect('monitors-changed', () => this._syncMonitorSettings());

        // Panel indicator with saturation slider
        this._indicator = new PanelMenu.Button(0.0, 'Saturation', false);
        const icon = new St.Icon({ icon_name: 'color-select-symbolic', style_class: 'system-status-icon' });
        this._indicator.add_child(icon);

        // On/off switch
        this._switchItem = new PopupMenu.PopupSwitchMenuItem('Enabled', true);
        this._switchItem.connect('toggled', (item, state) => {
            this._active = state;
            // Enable/disable slider interactions
            if (this._slider)
                this._slider.reactive = this._active;
            this._syncSettings();
            this._refreshUiActiveState();
        });
        this._indicator.menu.addMenuItem(this._switchItem);

        // Slider value maps 0..1 -> saturation 0..2
        const currentSat = this._getGlobalSaturation();
        this._slider = new Slider.Slider(Math.min(Math.max(currentSat / 2.0, 0.0), 1.0));

        // Title row above the slider
        const titleItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        titleItem.add_child(new St.Label({ text: 'Saturation' }));
        this._indicator.menu.addMenuItem(titleItem);
        this._titleItem = titleItem;

        const onSliderChanged = () => {
            if (this._ignoreSlider)
                return;
            const value = this._slider.value; // 0..1
            const sat = Math.min(Math.max(value * 2.0, 0.0), 2.0);
            const satFactors = this._settings.get_value('saturation-factors').deep_unpack();
            // index 0 is the global/all monitors value
            satFactors[0] = sat;
            this._settings.set_value('saturation-factors', new GLib.Variant('ad', satFactors));
        };
        this._slider.connect('notify::value', onSliderChanged);

        // Snap to center (0.5) when close; react to both drag-end and button-release
        const SNAP_THRESHOLD = 0.05; // within 5% to snap
        const doSnapIfNearCenter = () => {
            const v = this._slider.value;
            if (Math.abs(v - 0.5) <= SNAP_THRESHOLD) {
                this._ignoreSlider = true;
                this._slider.value = 0.5;
                this._ignoreSlider = false;
            }
            onSliderChanged();
        };
        this._slider.connect('drag-end', doSnapIfNearCenter);
        this._slider.connect('button-release-event', () => { doSnapIfNearCenter(); return Clutter.EVENT_PROPAGATE; });

        // Put the slider inside a non-reactive menu item
        this._sliderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._sliderItem.add_child(this._slider);
        this._indicator.menu.addMenuItem(this._sliderItem);

        // Middle mark under the slider
        const markItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const markBox = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        markBox.add_child(new St.Widget({ x_expand: true }));
        // Center mark (more visible)
        markBox.add_child(new St.Widget({ width: 2, height: 10, style: 'background-color: rgba(255,255,255,0.7); border-radius: 1px;' }));
        markBox.add_child(new St.Widget({ x_expand: true }));
        markItem.add_child(markBox);
        this._indicator.menu.addMenuItem(markItem);
        this._markItem = markItem;

        Main.panel.addToStatusArea('saturationIndicator', this._indicator);

        this._syncMonitorSettings();
        this._syncSettings();
        this._syncIndicatorFromSettings();
        this._refreshUiActiveState();
    }

    _syncMonitorSettings() {
        if (!this._effect) return;

        const compositorSize = [Main.layoutManager.uiGroup.width, Main.layoutManager.uiGroup.height];

        const storedIds = this._settings.get_strv('monitor-ids');

        let monitorRects = [];
        let monitorCount = 0;

        for (let t=0; t<MAX_MONITORS_SUPPORTED && t<storedIds.length; t++) {
            let monitorIdx = this._monitorManager.get_monitor_for_connector(storedIds[t]);
            if (monitorIdx === -1) {
                continue;
            }

            const monitor = Main.layoutManager.monitors[monitorIdx];

            monitorRects.push(monitor.x, monitor.y, monitor.width, monitor.height);
            monitorCount++;
        }

        this._monitorCount = monitorCount;
        this._effect.setMonitorParams(monitorCount, monitorRects, compositorSize);
    }

    _syncSettings(key) {
        if (!this._effect) return;

        if (key === 'monitor-ids') {
            this._syncMonitorSettings();
        }

        const usePerMonitor = this._settings.get_boolean('use-per-monitor-settings');
        const storedSats = this._settings.get_value('saturation-factors').deep_unpack();
        const storedHuesDeg = this._settings.get_value('hue-shifts').deep_unpack();
        const storedColorInverts = this._settings.get_value('invert-colors').deep_unpack();

        const saturationFactors = [];
        const hueShifts = [];
        const colorInverts = [];

        for (let t=0; t<=this._monitorCount && t <= MAX_MONITORS_SUPPORTED; t++) {
            saturationFactors.push(parseFloat(storedSats[t] || 0.0));
            hueShifts.push(parseFloat(storedHuesDeg[t] || 0.0)*Math.PI/180);
            colorInverts.push(storedColorInverts[t] ? 1.0 : 0.0);
        }

        // If deactivated, apply neutral values without changing settings
        if (!this._active) {
            for (let i = 0; i < saturationFactors.length; i++) {
                saturationFactors[i] = 1.0;
                hueShifts[i] = 0.0;
                colorInverts[i] = 0.0;
            }
        }

        // glslEffect only allows setting float values
        this._effect.setParams({
            use_per_monitor: usePerMonitor ? 1 : 0,
            saturation_factors: saturationFactors,
            hue_shifts: hueShifts,
            color_inverts: colorInverts
        });
    }

    _getGlobalSaturation() {
        const storedSats = this._settings.get_value('saturation-factors').deep_unpack();
        let sat = parseFloat(storedSats[0]);
        if (!Number.isFinite(sat))
            sat = 1.0;
        // Clamp 0..2
        return Math.min(Math.max(sat, 0.0), 2.0);
    }

    _syncIndicatorFromSettings() {
        if (!this._slider)
            return;
        this._ignoreSlider = true;
        try {
            const sat = this._getGlobalSaturation();
            this._slider.value = Math.min(Math.max(sat / 2.0, 0.0), 1.0);
        } finally {
            this._ignoreSlider = false;
        }
    }

    _refreshUiActiveState() {
        const opacity = this._active ? 255 : 120; // dim when disabled
        if (this._slider)
            this._slider.reactive = this._active;
        if (this._sliderItem)
            this._sliderItem.opacity = opacity;
        if (this._titleItem)
            this._titleItem.opacity = opacity;
        if (this._markItem)
            this._markItem.opacity = opacity;
        if (this._switchItem)
            this._switchItem.opacity = 255; // keep switch readable
    }

    disable() {
        Main.layoutManager.disconnect(this._monitorChangedId);
        Main.layoutManager.uiGroup.remove_effect(this._effect);
        this._effect = null;

        // Restore unredirect
        if (Meta.enable_unredirect_for_display) {
            Meta.enable_unredirect_for_display(global.display);
        } else {
            global.compositor.enable_unredirect();
        }

        this._settings.disconnect(this._settingsChangedId);
        this._settings = null;
        this._monitorManager = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
            this._sliderItem = null;
            this._slider = null;
            this._titleItem = null;
            this._markItem = null;
            this._switchItem = null;
        }
    }
}
