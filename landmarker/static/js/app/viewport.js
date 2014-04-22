define(['jquery', 'underscore', 'backbone', 'three', './camera'],
function ($, _, Backbone, THREE, Camera) {

"use strict";

var Viewport = Backbone.View.extend({

    id: 'vpoverlay',

    initialize: function () {

        // ----- CONFIGURATION ----- //
        this.meshScale = 1.0;  // The radius of the mesh's bounding sphere
        // the radius of the landmarks in the normalized scene
        // TODO this should be on app not Viewport
        this.landmarkScale = 0.01;
        var clearColor = 0xAAAAAA;

        // TODO bind all methods on the Viewport
        _.bindAll(this, 'resize', 'render', 'changeMesh',
            'mousedownHandler', 'update', 'lmViewsInSelectionBox');

        // ----- DOM ----- //
        // We have three DOM concerns:
        //
        //  viewportContainer: a flexbox container for general UI sizing
        //    - vpoverlay: a Canvas overlay for 2D UI drawing
        //    - viewport: our THREE managed WebGL view
        //
        // The viewport and vpoverlay need to be position:fixed for WebGL
        // reasons. we listen for document resize and keep the size of these
        // two children in sync with the viewportContainer parent.
        this.$container = $('#viewportContainer');
        // and grab the viewport div
        this.$webglel = $('#viewport');
        // Get a hold on the overlay canvas and its context (note we use the
        // id - the Viewport should be passed the canvas element on
        // construction)
        this.canvas = document.getElementById(this.id);
        this.ctx = this.canvas.getContext('2d');

        // ------ SCENE GRAPH CONSTRUCTION ----- //
        this.scene = new THREE.Scene();

        // ----- SCENE: MODEL AND LANDMARKS ----- //
        // s_meshAndLms stores the mesh and landmarks in the meshes original
        // coordinates. This is always transformed to the unit sphere for
        // consistency of camera.
        this.s_meshAndLms = new THREE.Object3D();
        // s_lms stores the scene landmarks. This is a useful container to
        // get at all landmarks in one go, and is a child of s_meshAndLms
        this.s_lms = new THREE.Object3D();
        this.s_meshAndLms.add(this.s_lms);
        // s_mesh is the parent of the mesh itself in the THREE scene.
        // This will only ever have one child (the mesh).
        // Child of s_meshAndLms
        this.s_mesh = new THREE.Object3D();
        this.s_meshAndLms.add(this.s_mesh);
        this.scene.add(this.s_meshAndLms);

        // ----- SCENE: CAMERA AND DIRECTED LIGHTS ----- //
        // s_camera holds the camera, and (optionally) any
        // lights that track with the camera as children
        this.s_camera = new THREE.PerspectiveCamera(50, 1, 0.02, 5000);
        this.s_camera.position.set(1.68, 0.35, 3.0);
        this.resetCamera();

        // ----- SCENE: GENERAL LIGHTING ----- //
        // TODO make lighting customizable
        this.s_lights = new THREE.Object3D();
        var pointLightLeft = new THREE.PointLight(0x404040, 1, 0);
        pointLightLeft.position.set(-100, 0, 100);
        this.s_lights.add(pointLightLeft);
        var pointLightRight = new THREE.PointLight(0x404040, 1, 0);
        pointLightRight.position.set(100, 0, 100);
        this.s_lights.add(pointLightRight);
        this.scene.add(this.s_lights);
        // add a soft white ambient light
        this.s_lights.add(new THREE.AmbientLight(0x404040));

        this.renderer = new THREE.WebGLRenderer({antialias: true, alpha: false});
        this.renderer.setClearColor(clearColor, 1);
        this.renderer.autoClear = false;
        // attach the render on the element we picked out earlier
        this.$webglel.html(this.renderer.domElement);

        // we  build a second scene for various helpers we may need
        // (intersection planes)
        this.sceneHelpers = new THREE.Scene();

        // add mesh if there already is one present (we have missed a
        // backbone callback to changeMesh() otherwise).
        var mesh = this.model.mesh();
        if (mesh && mesh.t_mesh()) {
            this.changeMesh();
        }

        // make an empty list of landmark views
        this.landmarkViews = [];
        this.cameraControls = Camera.CameraController(
            this.s_camera, this.el);
        // when the camera updates, render
        this.cameraControls.on("change", this.update);

        var downEvent, lmPressed, lmPressedWasSelected;

        // Tools for moving betweens screen and world coordinates
        this.ray = new THREE.Raycaster();
        this.projector = new THREE.Projector();

        // ----- MOUSE HANDLER ----- //
        // There is quite a lot of finicky state in handling the mouse
        // interaction which is of no concern to the rest of the viewport.
        // We wrap all this complexity up in a closure so it can enjoy access
        // to the general viewport state without leaking it's state all over
        // the place.
        var that = this;
        this.handler = (function () {
        // x, y position of mouse on click states
        var onMouseDownPosition = new THREE.Vector2();
        var onMouseUpPosition = new THREE.Vector2();

        // current world position when in drag state
        var positionLmDrag = new THREE.Vector3();
        // vector difference in one time step
        var deltaLmDrag = new THREE.Vector3();

        // where we store the intersection plane
        var intersectionPlanePosition = new THREE.Vector3();
        var intersectionsWithLms, intersectionsWithMesh,
            intersectionsOnPlane;

        // ----- OBJECT PICKING  ----- //
        var intersectionPlane = new THREE.Mesh(
            new THREE.PlaneGeometry(100, 100));
        intersectionPlane.visible = false;
        that.sceneHelpers.add(intersectionPlane);


        // Catch all for mouse interaction. This is what is bound on the canvas
        // and delegates to various other mouse handlers once it figures out
        // what the user has done.
        var onMouseDown = function (event) {
            event.preventDefault();
            that.$el.focus();
            downEvent = event;
            onMouseDownPosition.set(event.offsetX, event.offsetY);
            if (event.button === 0 && event.shiftKey) {
                shiftPressed();  // LMB + SHIFT
            }
            // All other interactions require interactions to
            // distinguish - calculate here.
            intersectionsWithLms = that.getIntersectsFromEvent(event, that.s_lms);
            intersectionsWithMesh = that.getIntersectsFromEvent(event, that.s_mesh);
            if (event.button === 0) {  // left mouse button
                if (intersectionsWithLms.length > 0 &&
                    intersectionsWithMesh.length > 0) {
                    // degenerate case - which is closer?
                    if (intersectionsWithLms[0].distance <
                        intersectionsWithMesh[0].distance) {
                        landmarkPressed(event);
                    } else {
                        meshPressed();
                    }
                } else if (intersectionsWithLms.length > 0) {
                    landmarkPressed(event);
                } else if (intersectionsWithMesh.length > 0) {
                    meshPressed();
                } else {
                    nothingPressed();
                }
            }

            function meshPressed() {
                console.log('mesh pressed!');
                $(document).one('mouseup.viewportMesh', meshOnMouseUp);
            }

            function landmarkPressed() {
                var ctrl = (downEvent.ctrlKey || downEvent.metaKey);
                console.log('landmark pressed!');
                // before anything else, disable the camera
                that.cameraControls.disable();
                // the clicked on landmark
                var landmarkSymbol = intersectionsWithLms[0].object;
                var group;
                // hunt through the landmarkViews for the right symbol
                for (var i = 0; i < that.landmarkViews.length; i++) {
                    if (that.landmarkViews[i].symbol === landmarkSymbol) {
                        lmPressed = that.landmarkViews[i].model;
                        group = that.landmarkViews[i].group;
                    }
                }
                group.activate();
                lmPressedWasSelected = lmPressed.isSelected();
                if (!lmPressedWasSelected && !ctrl) {
                    // this lm wasn't pressed before and we aren't holding
                    // mutliselection down - deselect rest and select this
                    console.log("normal click on a unselected lm - deselecting rest and selecting me");
                    lmPressed.collection.deselectAll();
                    lmPressed.select();
                }
                if (ctrl && !lmPressedWasSelected) {
                    lmPressed.select();
                }

//                if (group.landmarks().nSelected() >= 1) {
//                    // This is a multiple selection -
//                }
//                if ((event.ctrlKey || event.metaKey)) {
//                    if(landmark.isSelected()) {
//                        landmark.deselect();
//                    } else {
//                        landmark.select();
//                    }
//                } else {
//                    landmark.collection.deselectAll();
//                    landmark.select();
//                }
                // now we've selected the landmark, we want to enable dragging.
                // Fix the intersection plane to be where we clicked, only a
                // little nearer to the camera.
                positionLmDrag.copy(intersectionsWithLms[0].point);
                intersectionPlanePosition.subVectors(that.s_camera.position,
                    positionLmDrag);
                intersectionPlanePosition.divideScalar(10.0);
                intersectionPlanePosition.add(positionLmDrag);
                intersectionPlane.position.copy(intersectionPlanePosition);
                intersectionPlane.lookAt(that.s_camera.position);
                intersectionPlane.updateMatrixWorld();
                // start listening for dragging landmarks
                $(document).on('mousemove.landmarkDrag', landmarkOnDrag);
                $(document).one('mouseup.viewportLandmark', landmarkOnMouseUp);
            }

            function nothingPressed() {
                console.log('nothing pressed!');
                $(document).one('mouseup.viewportNothing', nothingOnMouseUp);
            }

            function shiftPressed() {
                console.log('shift pressed!');
                // before anything else, disable the camera
                that.cameraControls.disable();
                $(document).on('mousemove.shiftDrag', shiftOnDrag);
                $(document).one('mouseup.viewportShift', shiftOnMouseUp);
            }
        };

        var landmarkOnDrag = function (event) {
            console.log("drag");
            intersectionsOnPlane = that.getIntersectsFromEvent(event,
                intersectionPlane);
            if (intersectionsOnPlane.length > 0) {
                var intersectMeshSpace = intersectionsOnPlane[0].point.clone();
                var prevIntersectInMeshSpace = positionLmDrag.clone();
                that.s_meshAndLms.worldToLocal(intersectMeshSpace);
                that.s_meshAndLms.worldToLocal(prevIntersectInMeshSpace);
                // change in this step in mesh space
                deltaLmDrag.subVectors(intersectMeshSpace, prevIntersectInMeshSpace);
                // update the position
                positionLmDrag.copy(intersectionsOnPlane[0].point);
                var activeGroup = that.model.get('landmarks').get('groups').active();
                var selectedLandmarks = activeGroup.landmarks().selected();
                var lm, lmP;
                that.model.dispatcher().enableBatchRender();
                for (var i = 0; i < selectedLandmarks.length; i++) {
                    lm = selectedLandmarks[i];
                    lmP = lm.point().clone();
                    lmP.add(deltaLmDrag);
                    //if (!lm.get('isChanging')) lm.set('isChanging', true);
                    lm.setPoint(lmP);
                }
                that.model.dispatcher().disableBatchRender();
            }
        };

        var shiftOnDrag = function (event) {
            console.log("shift:drag");
            // note - we use client as we don't want to jump back to zero
            // if user drags into sidebar!
            var newX = event.clientX;
            var newY = event.clientY;
            // clear the canvas and draw a selection rect.
            that.clearCanvas();
            var x = onMouseDownPosition.x;
            var y = onMouseDownPosition.y;
            var dx = newX - x;
            var dy = newY - y;
            that.ctx.strokeRect(x, y, dx, dy);
        };

        var shiftOnMouseUp = function (event) {
            that.cameraControls.enable();
            console.log("shift:up");
            $(document).off('mousemove.shiftDrag', shiftOnDrag);
            var x1 = onMouseDownPosition.x;
            var y1 = onMouseDownPosition.y;
            var x2 = event.clientX;
            var y2 = event.clientY;
            var min_x, max_x, min_y, max_y;
            if (x1 < x2) {
                min_x = x1;
                max_x = x2;
            } else {
                min_x = x2;
                max_x = x1;
            }
            if (y1 < y2) {
                min_y = y1;
                max_y = y2;
            } else {
                min_y = y2;
                max_y = y1;
            }
            // First, let's just find all the landamarks that in screen space
            // are within our selection.
            var lms = that.lmViewsInSelectionBox(min_x, min_y,
                                                 max_x, max_y);

            // Of these, filter out the ones which are visible (not obscured)
            var visibleLms = [];
            _.each(lms, function(lm) {
                if (that.lmViewVisible(lm)) {
                    visibleLms.push(lm);
                }
            });

            console.log(visibleLms.length);
            _.each(visibleLms, function (lm) {
                lm.model.select();
            });



            that.clearCanvas();
        };

        var meshOnMouseUp = function (event) {
            console.log("meshPress:up");
            var p;
            onMouseUpPosition.set(event.offsetX, event.offsetY);
            if (onMouseDownPosition.distanceTo(onMouseUpPosition) < 2) {
                //  a click on the mesh
                p = intersectionsWithMesh[0].point.clone();
                // Convert the point back into the mesh space
                that.s_meshAndLms.worldToLocal(p);
                that.model.get('landmarks').insertNew(p);
            }
        };

        var nothingOnMouseUp = function (event) {
            console.log("nothingPress:up");
            onMouseUpPosition.set(event.offsetX, event.offsetY);
            if (onMouseDownPosition.distanceTo(onMouseUpPosition) < 2) {
                // a click on nothing - deselect all
                that.model.get('landmarks').get('groups').deselectAll();
            }
        };

        var landmarkOnMouseUp = function (event) {
            var ctrl = downEvent.ctrlKey || downEvent.metaKey;
            that.cameraControls.enable();
            console.log("landmarkPress:up");
            $(document).off('mousemove.landmarkDrag');
            var lm;
            onMouseUpPosition.set(event.offsetX, event.offsetY);
            if (onMouseDownPosition.distanceTo(onMouseUpPosition) > 2) {
                // landmark was dragged
                var activeGroup = that.model.get('landmarks').get('groups').active();
                var selectedLandmarks = activeGroup.landmarks().selected();
                var camToLm;
                for (var i = 0; i < selectedLandmarks.length; i++) {
                    lm = selectedLandmarks[i];
                    camToLm = that.s_meshAndLms.localToWorld(lm.point().clone()).sub(
                        that.s_camera.position).normalize();
                    // make the ray points from camera to this point
                    that.ray.set(that.s_camera.position, camToLm);
                    intersectionsWithLms = that.ray.intersectObject(
                        that.s_mesh, true);
                    if (intersectionsWithLms.length > 0) {
                        // good, we're still on the mesh.
                        lm.setPoint(that.s_meshAndLms.worldToLocal(
                            intersectionsWithLms[0].point.clone()));
                        lm.set('isChanging', false);
                    } else {
                        console.log("fallen off mesh");
                        // TODO add back in history!
//                                for (i = 0; i < selectedLandmarks.length; i++) {
//                                    selectedLandmarks[i].rollbackModifications();
//                                }
                        // ok, we've fixed the mess. drop out of the loop
                        break;
                    }
                    // only here as all landmarks were successfully moved
                    //landmarkSet.snapshotGroup(); // snapshot the active group
                }
            } else {
                // landmark was pressed
                if (lmPressedWasSelected && ctrl) {
                    lmPressed.deselect();
                }
            }
        };
        return onMouseDown
        })();

        // ----- BIND HANDLERS ----- //
        window.addEventListener('resize', this.resize, false);
        this.listenTo(this.model.get('meshSource'), "change:mesh", this.changeMesh);
        this.listenTo(this.model, "change:landmarks", this.changeLandmarks);
        this.listenTo(this.model.dispatcher(), "change:BATCH_RENDER", this.batchHandler);

        // trigger resize, and register for the animation loop
        this.resize();
        animate();

        function animate() {
            requestAnimationFrame(animate);
        }
    },

    // ----- EVENTS ----- //
    // General function for finding intersections from a mouse click event
    // to some group of objects in s_scene.
    getIntersects: function (x, y, object) {
        if (object === null || object.length === 0) {
            return [];
        }
        var vector = new THREE.Vector3(
                (x / this.$container.width()) * 2 - 1,
                -(y / this.$container.height()) * 2 + 1, 0);
        this.projector.unprojectVector(vector, this.s_camera);
        this.ray.set(this.s_camera.position,
            vector.sub(this.s_camera.position).normalize());
        if (object instanceof Array) {
            return this.ray.intersectObjects(object, true);
        }
        return this.ray.intersectObject(object, true);
    },

    getIntersectsFromEvent: function (event, object) {
      return this.getIntersects(event.offsetX, event.offsetY, object);
    },

    worldToScreen: function (vector) {
        var widthHalf = this.$container.width() / 2;
        var heightHalf = this.$container.height() / 2;
        var result = this.projector.projectVector(vector.clone(), this.s_camera);
        result.x = (result.x * widthHalf) + widthHalf;
        result.y = -(result.y * heightHalf) + heightHalf;
        return result;
    },

    lmToScreen: function (lmSymbol) {
        var pos = lmSymbol.position.clone();
        this.s_meshAndLms.localToWorld(pos);
        return this.worldToScreen(pos);
    },

    lmViewsInSelectionBox: function (x1, y1, x2, y2) {
        var c;
        var lmsInBox = [];
        var that = this;
        _.each(this.landmarkViews, function (lmView) {
            if (lmView.symbol) {
                c = that.lmToScreen(lmView.symbol);
                if (c.x > x1 && c.x < x2 && c.y > y1 && c.y < y2) {
                    lmsInBox.push(lmView);
                }
            }

        });
        return lmsInBox;
    },

    lmViewVisible: function (lmView) {
        if (!lmView.symbol) {
            return false;
        }
        var screenCoords = this.lmToScreen(lmView.symbol);
        var i = this.getIntersects(screenCoords.x, screenCoords.y,
            [this.s_mesh, lmView.symbol]);
        // is the nearest intersection the one we want?
        return (i[0].object === lmView.symbol)
    },

    events: {
        'mousedown' : "mousedownHandler"
    },

    mousedownHandler: function (event) {
        event.preventDefault();
        // delegate to the handler closure
        this.handler(event);
    },

    changeMesh: function () {
        console.log('Viewport: mesh has changed');
        if (this.mesh) {
            console.log('stopping listening to previous mesh');
            this.stopListening(this.mesh);
        }
        console.log('listening to new mesh');
        this.listenTo(this.model.mesh(), "all", this.update);
        this.mesh = this.model.mesh();
        // firstly, remove any existing mesh
        if (this.s_mesh.children.length) {
            this.s_mesh.remove(this.s_mesh.children[0]);
        }
        var t_mesh = this.model.mesh().get('t_mesh');
        this.s_mesh.add(t_mesh);

        // Now we need to rescale the s_meshAndLms to fit in the unit sphere
        // First, the scale
        this.meshScale = t_mesh.geometry.boundingSphere.radius;
        var s = 1.0 / this.meshScale;
        this.s_meshAndLms.scale.set(s, s, s);

        // THREE.js applies translation AFTER scale, so need to calc
        // appropriate translation
        var t = t_mesh.geometry.boundingSphere.center.clone();
        t.multiplyScalar(-1.0 * s);  // -1 as we want to centre
        this.s_meshAndLms.position = t;
        this.resetCamera();
        this.update();
    },

    changeLandmarks: function () {
        console.log('Viewport: landmarks have changed');
        var that = this;
        // 1. Clear the scene graph of all landmarks
        // TODO should this be a destructor on LandmarkView?
        this.s_meshAndLms.remove(this.s_lms);
        this.s_lms = new THREE.Object3D();
        this.s_meshAndLms.add(this.s_lms);
        // 2. Build a fresh set of views - clear any existing lms
        this.landmarkViews = [];
        var groups = this.model.get('landmarks').get('groups');
        groups.each(function (group) {
            group.get('landmarks').each(function (lm) {
                that.landmarkViews.push(new LandmarkTHREEView(
                    {
                        model: lm,
                        group: group,
                        viewport: that
                    }));
            });
        })
    },

    // this is called whenever there is a state change on the THREE scene
    update: function () {
        if (!this.renderer) {
            return;
        }
        // if in batch mode - noop.
        if (this.model.dispatcher().isBatchRenderEnabled()) {
            return;
        }
        //console.log('Viewport:update');
        this.renderer.clear();
        this.renderer.render(this.scene, this.s_camera);
        this.renderer.render(this.sceneHelpers, this.s_camera);
    },

    resetCamera: function () {
        this.s_camera.position.set(1.68, 0.35, 3.0);
        this.s_camera.lookAt(this.scene.position);
        this.update();
    },

    clearCanvas: function () {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    },

    resize: function () {
        var w, h;
        w = this.$container.width();
        h = this.$container.height();
        this.s_camera.aspect = w / h;
        this.s_camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.canvas.width = w;
        this.canvas.height = h;
        this.update();
    },

    batchHandler: function (dispatcher) {
        if (!dispatcher.isBatchRenderEnabled()) {
            // just been turned off - trigger an update.
            this.update();
        }
    }

});


var LandmarkTHREEView = Backbone.View.extend({

    initialize: function (options) {
        this.listenTo(this.model, "change", this.render);
        this.group = options.group;
        this.viewport = options.viewport;
        this.listenTo(this.group, "change:active", this.render);
        this.symbol = null; // a THREE object that represents this landmark.
        // null if the landmark isEmpty
        this.render();
    },

    render: function () {
        if (this.symbol !== null) {
            // this landmark already has an allocated representation..
            if (this.model.isEmpty()) {
                // but it's been deleted.
                this.viewport.s_lms.remove(this.symbol);
                this.symbol = null;

            } else {
                // the lm may need updating. See what needs to be done
                this.updateSymbol();
            }
        } else {
            // there is no symbol yet
            if (!this.model.isEmpty()) {
                // and there should be! Make it and update it
                this.symbol = this.createSphere(this.model.get('point'),
                    this.viewport.landmarkScale * this.viewport.meshScale, 1);
                this.updateSymbol();
                // and add it to the scene
                this.viewport.s_lms.add(this.symbol);
            }
        }
        // tell our viewport to update
        this.viewport.update();
    },

    createSphere: function (v, radius, selected) {
        var wSegments = 10;
        var hSegments = 10;
        var geometry = new THREE.SphereGeometry(radius, wSegments, hSegments);
        var landmark = new THREE.Mesh(geometry, createDummyMaterial(selected));
        landmark.name = 'Sphere ' + landmark.id;
        landmark.position.copy(v);
        return landmark;
        function createDummyMaterial(selected) {
            var hexColor = 0xffff00;
            if (selected) {
                hexColor = 0xff75ff
            }
            return new THREE.MeshPhongMaterial({color: hexColor});
        }
    },

    updateSymbol: function () {
        this.symbol.position.copy(this.model.point());
        if (this.group.get('active') && this.model.isSelected()) {
            this.symbol.material.color.setHex(0xff75ff);
        } else {
            this.symbol.material.color.setHex(0xffff00);
        }
    }
});

return {
    Viewport: Viewport
}

});
