module.exports = function (RED) {
    function UIQrCodeScannerNode (config) {
        RED.nodes.createNode(this, config)

        const node = this

        const group = RED.nodes.getNode(config.group)

        const base = group.getBase()

        // Properties that can be overridden at runtime via msg.ui_update.<name>
        const dynamicProps = [
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

        const evts = {
            onAction: true,
            beforeSend: function (msg) {
                const updates = msg.ui_update
                if (updates) {
                    for (const key of dynamicProps) {
                        if (typeof updates[key] !== 'undefined') {
                            base.stores.state.set(base, node, msg, key, updates[key])
                        }
                    }
                }
                return msg
            },
            onInput: function (msg, send, done) {
                // Persist the last input so the widget can re-hydrate on reload
                base.stores.data.save(base, node, msg)
                send(msg)
                done && done()
            }
        }

        if (group) {
            group.register(node, config, evts)
        } else {
            node.error('No group configured')
        }
    }

    RED.nodes.registerType('ui-qrcode-scanner', UIQrCodeScannerNode)
}
