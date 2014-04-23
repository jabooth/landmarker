define(['backbone', './landmark', './mesh', './dispatcher',
        './server'],
    function (Backbone, Landmark, Mesh, Dispatcher, Server) {

    "use strict";

    var App = Backbone.Model.extend({

        defaults: function () {
            return {
                landmarkType: 'ibug68',
                apiURL: ''
            }
        },

        server: function () {
            return this.get('server');
        },

        initialize: function () {
            _.bindAll(this, 'meshChanged');
            this.set('dispatcher', new Dispatcher.Dispatcher);
            // construct a new server to handle dynamic remapping of URLs
            this.set('server', new Server.Server(
                {
                    apiURL: this.get('apiURL')
                }
            ));
            // construct a mesh source (which can query for mesh information
            // from the server). Of course, we must pass the server in. The
            // mesh source will ensure that the meshes produced also get
            // attached to this server.
            this.set('meshSource', new Mesh.MeshSource(
                {
                    server:this.server()
                }
            ));
            var meshes = this.get('meshSource');
            var that = this;
            meshes.fetch({
                success: function () {
                    var meshSource = that.get('meshSource');
                    meshSource.setMesh(meshSource.get('meshes').at(0));
                }
            });
            // whenever our mesh source changes it's current mesh we need
            // to run the application logic.
            this.listenTo(meshes, 'change:mesh', this.meshChanged);
        },

        dispatcher: function () {
            return this.get('dispatcher');
        },

        meshChanged: function () {
            console.log('mesh has been changed on the meshSource!');
            // build new landmarks - they need to know where to fetch from
            // so attach the server.
            var landmarks = new Landmark.LandmarkSet(
                {
                    id: this.mesh().id,
                    type: this.get('landmarkType'),
                    server: this.get('server')
                }
            );
            var that = this;
            landmarks.fetch({
                success: function () {
                    console.log('got the landmarks!');
                    that.set('landmarks', landmarks);
                },
                error: function () {
                    // can't find landmarks for this person! Grab the template
                    // instead
                    console.log("couldn't get the landmarks");
                    landmarks.set('from_template', 'true');
                    landmarks.fetch({
                        success: function () {
                            console.log('got the template landmarks!');
                            that.set('landmarks', landmarks);
                            landmarks.unset('from_template');
                        }
                    });
                }
            });
        },

        mesh: function () {
            return this.get('meshSource').get('mesh');
        },

        landmarks: function () {
            return this.get('landmarks');
        }
    });

    return {
        App: App
    };
});
