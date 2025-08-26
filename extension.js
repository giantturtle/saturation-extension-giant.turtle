import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';
import GLib from 'gi://GLib';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

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

        // Slider value maps 0..1 -> saturation 0..2
        const currentSat = this._getGlobalSaturation();
        this._slider = new Slider.Slider(Math.min(Math.max(currentSat / 2.0, 0.0), 1.0));

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
        this._slider.connect('drag-end', onSliderChanged);

        // Put the slider inside a non-reactive menu item
        this._sliderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._sliderItem.add_child(this._slider);
        this._indicator.menu.addMenuItem(this._sliderItem);

        Main.panel.addToStatusArea('saturationIndicator', this._indicator);

        this._syncMonitorSettings();
        this._syncSettings();
        this._syncIndicatorFromSettings();
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
            this._slider.setValue(Math.min(Math.max(sat / 2.0, 0.0), 1.0));
        } finally {
            this._ignoreSlider = false;
        }
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
        }
    }
}
