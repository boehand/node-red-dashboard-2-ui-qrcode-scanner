<template>
    <div class="ui-qrcode-scanner-wrapper">
        <div :id="readerId" class="ui-qrcode-scanner-reader">
            <div v-if="!scanning && !errorMessage" class="ui-qrcode-scanner-placeholder">
                Scanner stopped
            </div>
        </div>

        <div v-if="!hideControls" class="ui-qrcode-scanner-controls">
            <v-btn
                v-if="!scanning"
                color="primary"
                prepend-icon="mdi-camera"
                :disabled="!ready"
                @click="start"
            >
                {{ startLabel }}
            </v-btn>
            <v-btn
                v-else
                color="error"
                prepend-icon="mdi-stop"
                @click="stop"
            >
                {{ stopLabel }}
            </v-btn>

            <v-select
                v-if="cameras.length > 1 && !scanning"
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

        <div v-if="lastResult" class="ui-qrcode-scanner-result">
            <strong>Last scan:</strong> {{ lastResult }}
        </div>

        <div v-if="errorMessage" class="ui-qrcode-scanner-error">
            {{ errorMessage }}
        </div>
    </div>
</template>

<script>
import { Html5Qrcode } from 'html5-qrcode'

export default {
    name: 'UIQrCodeScanner',
    inject: ['$socket', '$dataTracker'],
    props: {
        /* Do not remove – Dashboard's Layout Manager passes these. */
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
    created () {
        // Register input/load/dynamic-property handlers with Dashboard 2
        this.$dataTracker(this.id, this.onInput, this.onLoad, this.onDynamicProperties)
    },
    async mounted () {
        // Defer until the reader div is in the DOM
        await this.$nextTick()
        try {
            this.html5QrCode = new Html5Qrcode(this.readerId, { verbose: false })
        } catch (err) {
            this.errorMessage = `Failed to initialise scanner: ${err && err.message ? err.message : err}`
            return
        }

        try {
            const cams = await Html5Qrcode.getCameras()
            this.cameras = Array.isArray(cams) ? cams : []
            if (this.cameras.length > 0) {
                const preferRear = this.facingMode === 'environment'
                const match = this.cameras.find((c) => {
                    const label = (c.label || '').toLowerCase()
                    return preferRear
                        ? /back|rear|environment/.test(label)
                        : /front|user|face/.test(label)
                })
                this.selectedCameraId = match ? match.id : this.cameras[0].id
            }
            this.ready = true
        } catch (err) {
            // getCameras failed – we can still try facingMode-based start
            this.ready = true
            // eslint-disable-next-line no-console
            console.warn('[ui-qrcode-scanner] getCameras failed:', err)
        }

        if (this.autoStart) {
            this.start()
        }
    },
    async beforeUnmount () {
        await this.cleanup()
    },
    methods: {
        async start () {
            if (this.scanning || !this.html5QrCode) {
                return
            }
            this.errorMessage = null

            const config = {
                fps: this.fps,
                qrbox: { width: this.qrboxWidth, height: this.qrboxHeight },
                disableFlip: this.disableFlip
            }
            if (this.aspectRatio) {
                config.aspectRatio = this.aspectRatio
            }

            // Prefer an explicit deviceId when we have one, otherwise fall back to facingMode
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
                case 'start':
                    this.start()
                    break
                case 'stop':
                    this.stop()
                    break
                case 'toggle':
                    if (this.scanning) {
                        this.stop()
                    } else {
                        this.start()
                    }
                    break
                case 'torchOn':
                    if (!this.torchOn) {
                        this.toggleTorch()
                    }
                    break
                case 'torchOff':
                    if (this.torchOn) {
                        this.toggleTorch()
                    }
                    break
                default:
                    break
            }
        },
        onLoad (_msg, _state) {
            // Nothing extra to do on load – dynamic props are applied via state.
        },
        onDynamicProperties (msg) {
            const updates = msg && msg.ui_update
            if (!updates) {
                return
            }
            const allowed = [
                'fps',
                'qrboxWidth',
                'qrboxHeight',
                'aspectRatio',
                'cameraFacingMode',
                'autoStart',
                'stopOnScan',
                'hideControls',
                'showTorch',
                'disableFlip',
                'startLabel',
                'stopLabel'
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
</style>
