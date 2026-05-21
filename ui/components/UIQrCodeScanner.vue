<template>
    <div class="ui-qrcode-scanner-wrapper">
        <div class="ui-qrcode-scanner-video-area">
            <!-- html5-qrcode owns this div entirely – no Vue children inside -->
            <div :id="readerId" class="ui-qrcode-scanner-reader"></div>
            <div v-if="!scanning && !errorMessage" class="ui-qrcode-scanner-placeholder">
                Scanner stopped
            </div>
        </div>

        <div v-if="!hideControls" class="ui-qrcode-scanner-controls">
            <v-btn
                :color="scanning ? 'error' : 'primary'"
                :prepend-icon="scanning ? 'mdi-stop' : 'mdi-camera'"
                :disabled="!ready && !scanning"
                @click="scanning ? stop() : start()"
            >
                {{ scanning ? stopLabel : startLabel }}
            </v-btn>

            <v-select
                v-if="cameras.length > 1"
                v-model="selectedCameraId"
                :items="cameraOptions"
                item-title="title"
                item-value="value"
                label="Camera"
                density="compact"
                hide-details
                variant="outlined"
            />

            <v-btn
                v-if="scanning && showTorch && torchSupported"
                :color="torchOn ? 'warning' : undefined"
                :prepend-icon="torchOn ? 'mdi-flashlight-off' : 'mdi-flashlight'"
                @click="toggleTorch"
            >
                {{ torchOn ? 'Torch off' : 'Torch on' }}
            </v-btn>
        </div>

        <div v-if="lastResult && !hideLastResult" class="ui-qrcode-scanner-result">
            <strong>Last scan:</strong> {{ lastResult }}
        </div>

        <div v-if="errorMessage" class="ui-qrcode-scanner-error">
            {{ errorMessage }}
        </div>
    </div>
</template>

<script>
import { Html5Qrcode } from 'html5-qrcode'

// Module-level registry: tracks the active Html5Qrcode scanner per readerId.
// Dashboard 2 does not restart the Vue app on Node-RED redeploy, so mounted()
// can fire for a new instance while the old one is still alive (beforeUnmount
// was never called). We only store the scanner object – never the Vue instance –
// to avoid touching another component's managed DOM during Vue's patch cycle.
const _scanners = new Map()

export default {
    name: 'UIQrCodeScanner',
    inject: ['$socket', '$dataTracker'],
    props: {
        /* do not remove entries from this - Dashboard's Layout Manager will pass this data to your component */
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({ enabled: false, visible: false }) }
    },
    data () {
        return {
            html5QrCode: null,
            scanning: false,
            ready: false,
            cameras: [],
            selectedCameraId: null,
            lastResult: null,
            errorMessage: null,
            torchSupported: false,
            torchOn: false
        }
    },
    computed: {
        readerId () {
            return `qrcode-reader-${this.id}`
        },
        // All properties use the globally provided getProperty() from Dashboard 2,
        // which automatically checks both props and state (runtime overrides).
        fps () {
            const v = Number(this.getProperty('fps'))
            return Number.isFinite(v) && v > 0 ? v : 10
        },
        qrboxWidth () {
            const v = Number(this.getProperty('qrboxWidth'))
            return Number.isFinite(v) && v > 0 ? v : 250
        },
        qrboxHeight () {
            const v = Number(this.getProperty('qrboxHeight'))
            return Number.isFinite(v) && v > 0 ? v : 250
        },
        aspectRatio () {
            const v = parseFloat(this.getProperty('aspectRatio'))
            return Number.isFinite(v) && v > 0 ? v : null
        },
        facingMode () {
            return this.getProperty('cameraFacingMode') || 'environment'
        },
        cameraIndex () {
            const v = Number(this.getProperty('cameraIndex'))
            return Number.isInteger(v) && v >= 0 ? v : 0
        },
        hideLastResult () {
            return !!this.getProperty('hideLastResult')
        },
        autoStart () {
            return this.getProperty('autoStart') !== false
        },
        stopOnScan () {
            return !!this.getProperty('stopOnScan')
        },
        hideControls () {
            return !!this.getProperty('hideControls')
        },
        showTorch () {
            return !!this.getProperty('showTorch')
        },
        disableFlip () {
            return !!this.getProperty('disableFlip')
        },
        startLabel () {
            return this.getProperty('startLabel') || 'Start scanning'
        },
        stopLabel () {
            return this.getProperty('stopLabel') || 'Stop scanning'
        },
        cameraOptions () {
            return this.cameras.map((c) => ({ value: c.id, title: c.label || c.id }))
        }
    },
    watch: {
        async selectedCameraId (newId, oldId) {
            if (newId !== oldId && this.scanning) {
                await this.stop()
                await this.start()
            }
            if (newId && oldId !== null && !this.hideControls) {
                this.saveCameraCookie(newId)
            }
        }
    },
    created () {
        this.$dataTracker(this.id, this.onInput, this.onLoad, this.onDynamicProperties)
    },
    async mounted () {
        await this.$nextTick()
        // Stop any orphaned Html5Qrcode scanner left over from a previous mount
        // cycle. We only touch the scanner object, not the old Vue component,
        // so Vue's virtual DOM stays consistent and __vnode errors are avoided.
        const prevScanner = _scanners.get(this.readerId)
        if (prevScanner) {
            try { await prevScanner.stop() } catch (_) {}
            try { await prevScanner.clear() } catch (_) {}
            _scanners.delete(this.readerId)
        }
        const container = document.getElementById(this.readerId)
        if (container) {
            container.innerHTML = ''
        }
        try {
            this.html5QrCode = new Html5Qrcode(this.readerId, { verbose: false })
            _scanners.set(this.readerId, this.html5QrCode)
        } catch (err) {
            this.errorMessage = `Failed to initialise scanner: ${err && err.message ? err.message : err}`
            return
        }

        try {
            const cams = await Html5Qrcode.getCameras()
            this.cameras = Array.isArray(cams) ? cams : []
            if (this.cameras.length > 0) {
                let selected = null

                if (!this.hideControls) {
                    const savedId = this.loadCameraCookie()
                    if (savedId && this.cameras.some((c) => c.id === savedId)) {
                        selected = savedId
                    }
                }

                if (!selected) {
                    const idx = this.cameraIndex
                    if (idx > 0 && this.cameras.length >= idx) {
                        selected = this.cameras[idx - 1].id
                    }
                }

                if (!selected) {
                    const preferRear = this.facingMode === 'environment'
                    const match = this.cameras.find((c) => {
                        const label = (c.label || '').toLowerCase()
                        return preferRear
                            ? /back|rear|environment/.test(label)
                            : /front|user|face/.test(label)
                    })
                    selected = match ? match.id : this.cameras[0].id
                }

                this.selectedCameraId = selected
            }
            this.ready = true
        } catch (err) {
            this.ready = true
            // eslint-disable-next-line no-console
            console.warn('[ui-qrcode-scanner] getCameras failed:', err)
        }

        if (this.autoStart) {
            this.start()
        }
    },
    async beforeUnmount () {
        _scanners.delete(this.readerId)
        await this.cleanup()
    },
    methods: {
        async start () {
            if (this.scanning || !this.html5QrCode) {
                return
            }
            this.errorMessage = null

            const readerId = this.readerId
            const config = {
                fps: this.fps,
                // viewfinderWidth/Height are the CSS pixel dimensions of the rendered
                // video element, measured by html5-qrcode at onLoadedMetadata time –
                // more reliable than reading clientWidth/clientHeight at start() time.
                qrbox: (viewfinderWidth, viewfinderHeight) => {
                    const size = Math.max(50, Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.8))
                    return { width: size, height: size }
                },
                disableFlip: this.disableFlip
            }
            if (this.aspectRatio) {
                config.aspectRatio = this.aspectRatio
            }

            const cameraConfig = this.selectedCameraId
                ? { deviceId: { exact: this.selectedCameraId } }
                : { facingMode: this.facingMode }

            try {
                await this.html5QrCode.start(
                    cameraConfig,
                    config,
                    this.onScanSuccess,
                    this.onScanFailure
                )
                this.scanning = true
                this.detectTorchSupport()
                // Best-effort continuous autofocus – silently ignored if unsupported
                if (typeof this.html5QrCode.applyVideoConstraints === 'function') {
                    this.html5QrCode.applyVideoConstraints({
                        advanced: [{ focusMode: 'continuous' }]
                    }).catch(() => {})
                }
            } catch (err) {
                this.errorMessage = `Failed to start scanner: ${err && err.message ? err.message : err}`
                this.emitError(this.errorMessage)
            }
        },
        async stop () {
            if (!this.html5QrCode) {
                return
            }
            try {
                if (this.scanning) {
                    await this.html5QrCode.stop()
                }
            } catch (err) {
                // ignore – may already be stopped
            }
            this.scanning = false
            this.torchOn = false
        },
        async cleanup () {
            if (!this.html5QrCode) {
                return
            }
            _scanners.delete(this.readerId)
            try {
                if (this.scanning) {
                    await this.html5QrCode.stop()
                }
                await this.html5QrCode.clear()
            } catch (err) {
                // ignore
            }
            this.html5QrCode = null
            this.scanning = false
        },
        detectTorchSupport () {
            this.torchSupported = false
            try {
                const caps = this.html5QrCode.getRunningTrackCameraCapabilities &&
                    this.html5QrCode.getRunningTrackCameraCapabilities()
                if (caps && typeof caps.torchFeature === 'function') {
                    this.torchSupported = !!caps.torchFeature().isSupported()
                }
            } catch (err) {
                this.torchSupported = false
            }
        },
        async toggleTorch () {
            if (!this.torchSupported || !this.scanning) {
                return
            }
            try {
                const caps = this.html5QrCode.getRunningTrackCameraCapabilities()
                await caps.torchFeature().apply(!this.torchOn)
                this.torchOn = !this.torchOn
            } catch (err) {
                this.errorMessage = `Torch error: ${err && err.message ? err.message : err}`
            }
        },
        onScanSuccess (decodedText, decodedResult) {
            this.lastResult = decodedText
            const format = decodedResult &&
                decodedResult.result &&
                decodedResult.result.format &&
                decodedResult.result.format.formatName
            this.$socket.emit('widget-action', this.id, {
                payload: decodedText,
                topic: 'qrcode',
                qrcode: {
                    text: decodedText,
                    format: format || null,
                    result: decodedResult
                }
            })
            if (this.stopOnScan) {
                this.stop()
            }
        },
        onScanFailure (_error) {
            // Called continuously while no code is detected – stay silent.
        },
        emitError (message) {
            this.$socket.emit('widget-action', this.id, {
                payload: null,
                topic: 'qrcode/error',
                error: message
            })
        },
        onInput (msg) {
            if (!msg) {
                return
            }
            let action = msg.action
            if (!action && typeof msg.payload === 'string') {
                action = msg.payload
            }
            switch (action) {
                case 'start': this.start(); break
                case 'stop': this.stop(); break
                case 'toggle': this.scanning ? this.stop() : this.start(); break
                case 'torchOn': if (!this.torchOn) { this.toggleTorch() } break
                case 'torchOff': if (this.torchOn) { this.toggleTorch() } break
                default: break
            }
        },
        onLoad (_msg, _state) {},
        saveCameraCookie (cameraId) {
            try {
                const expires = new Date(Date.now() + 365 * 864e5).toUTCString()
                document.cookie = `nrdb-qrs-cam=${encodeURIComponent(cameraId)}; expires=${expires}; path=/; SameSite=Lax`
            } catch (_) {}
        },
        loadCameraCookie () {
            try {
                const part = document.cookie.split('; ').find((p) => p.startsWith('nrdb-qrs-cam='))
                return part ? decodeURIComponent(part.split('=')[1]) : null
            } catch (_) { return null }
        },
        onDynamicProperties (msg) {
            const updates = msg && msg.ui_update
            if (!updates) {
                return
            }
            // use the globally provided setDynamicProperties() from Dashboard 2
            const allowed = [
                'fps', 'qrboxWidth', 'qrboxHeight', 'aspectRatio', 'cameraFacingMode',
                'cameraIndex', 'autoStart', 'stopOnScan', 'hideControls', 'showTorch',
                'disableFlip', 'hideLastResult', 'startLabel', 'stopLabel'
            ]
            const changes = {}
            for (const key of allowed) {
                if (typeof updates[key] !== 'undefined') {
                    changes[key] = updates[key]
                }
            }
            if (Object.keys(changes).length > 0) {
                this.setDynamicProperties(changes)
            }
        }
    }
}
</script>

<style scoped>
@import "../stylesheets/ui-qrcode-scanner.css";

/* html5-qrcode injects a <section> and <video> dynamically – they don't get
   Vue's scoped data attribute, so :deep() is required for the rules to match. */
.ui-qrcode-scanner-reader :deep(section) {
    width: 100% !important;
    height: 100% !important;
}

.ui-qrcode-scanner-reader :deep(video) {
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
    display: block !important;
}
</style>
