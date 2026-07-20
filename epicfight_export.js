/**
 * EpicFight Blockbench Plugin - EF JSON Import/Export
 *
 * Imports EpicFight mesh/animation JSON into Blockbench,
 * then exports mesh, armature, and animation in EpicFight JSON format.
 */

// #region debug-point A:runtime-report
function debugReport(hypothesisId, location, msg, data) {
    try {
        fetch('http://127.0.0.1:7777/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: 'epicfight-tools',
                runId: 'post-fix',
                hypothesisId: hypothesisId,
                location: location,
                msg: '[DEBUG] ' + msg,
                data: data || {},
                ts: Date.now()
            })
        }).catch(function() {});
    } catch (e) {}
}
// #endregion

const GLTF_IMPORT_UNIT_SCALE = 16;
const IMPORTED_ARMATURE_BONE_WIDTH_MIN = 1.1;
const IMPORTED_ARMATURE_BONE_WIDTH_MAX = 1.8;
const IMPORTED_ARMATURE_BONE_LENGTH_FALLBACK = 4;
const IMPORTED_ARMATURE_HELPER_BONE_WIDTH_MIN = 0.7;
const IMPORTED_ARMATURE_HELPER_BONE_WIDTH_MAX = 1.05;
const IMPORTED_ARMATURE_HELPER_BONE_LENGTH_MIN = 1.1;

function scaleMatrixTranslation(matrix, translationScale) {
    if (!matrix || translationScale === 1) return matrix ? matrix.clone() : new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(pos, quat, scale);
    pos.multiplyScalar(translationScale);
    return new THREE.Matrix4().compose(pos, quat, scale);
}

function getMatrixTranslationLength(matrix) {
    if (!matrix) return 0;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(pos, quat, scale);
    return pos.length();
}

function getImportedBoneReferenceLength(boneData, childBones) {
    const children = Array.isArray(childBones) ? childBones : [];
    if (children.length) {
        const childLengths = children
            .map(child => getMatrixTranslationLength(child && (child.bindLocalMatrix || child.localMatrix || child.worldMatrix)))
            .filter(length => length > 0.0001);
        if (childLengths.length) {
            return childLengths.reduce((sum, length) => sum + length, 0) / childLengths.length;
        }
    }

    const ownLength = getMatrixTranslationLength(boneData && (boneData.bindLocalMatrix || boneData.localMatrix || boneData.worldMatrix));
    if (ownLength > 0.0001) {
        return ownLength;
    }
    return IMPORTED_ARMATURE_BONE_LENGTH_FALLBACK;
}

function isImportedHelperBone(boneData) {
    const name = boneData && boneData.name ? String(boneData.name) : '';
    return /^(knee|elbow)_/i.test(name);
}

function getImportedBoneDisplayLength(boneData, childBones) {
    const referenceLength = getImportedBoneReferenceLength(boneData, childBones);
    if (isImportedHelperBone(boneData)) {
        return roundNumber(Math.max(IMPORTED_ARMATURE_HELPER_BONE_LENGTH_MIN, referenceLength * 0.48), 4);
    }
    return roundNumber(Math.max(2, referenceLength), 4);
}

function getImportedBoneDisplayWidth(boneData, childBones) {
    const referenceLength = getImportedBoneReferenceLength(boneData, childBones);
    if (isImportedHelperBone(boneData)) {
        return roundNumber(Math.clamp(referenceLength * 0.12, IMPORTED_ARMATURE_HELPER_BONE_WIDTH_MIN, IMPORTED_ARMATURE_HELPER_BONE_WIDTH_MAX), 4);
    }
    return roundNumber(Math.clamp(referenceLength * 0.22, IMPORTED_ARMATURE_BONE_WIDTH_MIN, IMPORTED_ARMATURE_BONE_WIDTH_MAX), 4);
}

function getEFMeshVertexContainer(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('EpicFight mesh JSON root must be an object.');
    }
    if (data.vertices && typeof data.vertices === 'object') {
        return data.vertices;
    }
    return data;
}

function getEFPackedArray(entry, label) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.array)) {
        throw new Error('EpicFight mesh is missing ' + label + '.array.');
    }
    return entry.array.map(value => Number(value) || 0);
}

function parseEFTransformMatrix(transform) {
    if (Array.isArray(transform) && transform.length >= 16) {
        return parseEFMatrix(transform);
    }
    if (transform && typeof transform === 'object') {
        const loc = Array.isArray(transform.loc) ? transform.loc : [0, 0, 0];
        const sca = Array.isArray(transform.sca) ? transform.sca : [1, 1, 1];
        return new THREE.Matrix4().compose(
            new THREE.Vector3(
                Number(loc[0]) || 0,
                Number(loc[1]) || 0,
                Number(loc[2]) || 0
            ),
            makeQuaternionFromRotationValue(transform.rot),
            new THREE.Vector3(
                sca[0] === undefined ? 1 : (Number(sca[0]) || 0),
                sca[1] === undefined ? 1 : (Number(sca[1]) || 0),
                sca[2] === undefined ? 1 : (Number(sca[2]) || 0)
            )
        );
    }
    return new THREE.Matrix4();
}

function buildEFArmatureBones(armatureData) {
    if (!armatureData || typeof armatureData !== 'object' || !Array.isArray(armatureData.hierarchy)) {
        return [];
    }

    const rootAxisMatrix = new THREE.Matrix4().makeRotationFromQuaternion(EF_MATRIX_ROOT_AXIS_CORRECTION);
    const bones = [];

    function visit(node, parentName, isRootNode) {
        if (!node || typeof node !== 'object' || !node.name) return;
        let localMatrix = parseEFTransformMatrix(node.transform);
        localMatrix = scaleMatrixTranslation(localMatrix, GLTF_IMPORT_UNIT_SCALE);
        if (isRootNode) {
            localMatrix = rootAxisMatrix.clone().multiply(localMatrix);
        }
        bones.push({
            name: String(node.name),
            parentName: parentName || null,
            localMatrix: localMatrix.clone(),
            bindLocalMatrix: localMatrix.clone()
        });
        const children = Array.isArray(node.children) ? node.children : [];
        for (const child of children) {
            visit(child, String(node.name), false);
        }
    }

    for (const rootNode of armatureData.hierarchy) {
        visit(rootNode, null, true);
    }

    return bones;
}

function buildEFVertexWeights(vertexCount, vcounts, vindices, weights, jointNames) {
    if (!Array.isArray(vcounts) || !Array.isArray(vindices) || !Array.isArray(weights) || !jointNames || !jointNames.length) {
        return {};
    }

    const vertexWeights = {};
    let pointer = 0;

    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex++) {
        const influenceCount = Math.max(0, Math.floor(Number(vcounts[vertexIndex]) || 0));
        const weightList = [];

        for (let i = 0; i < influenceCount; i++) {
            if (pointer + 1 >= vindices.length) break;
            const jointIndex = Math.floor(Number(vindices[pointer++]) || 0);
            const weightIndex = Math.floor(Number(vindices[pointer++]) || 0);
            const boneName = jointNames[jointIndex];
            const weight = Number(weights[weightIndex]) || 0;
            if (!boneName || weight <= 0) continue;
            weightList.push({
                boneName: boneName,
                weight: weight
            });
        }

        const total = weightList.reduce((sum, entry) => sum + entry.weight, 0);
        if (total > 0) {
            for (const entry of weightList) {
                entry.weight = roundNumber(entry.weight / total, 6);
            }
            vertexWeights[vertexIndex] = weightList;
        }
    }

    return vertexWeights;
}

function buildEFMeshObjects(vertices, vertexWeights, fileName) {
    const positions = getEFPackedArray(vertices.positions, 'vertices.positions');
    const uvs = vertices.uvs && Array.isArray(vertices.uvs.array)
        ? vertices.uvs.array.map(value => Number(value) || 0)
        : [];
    const parts = vertices.parts && typeof vertices.parts === 'object'
        ? vertices.parts
        : { mesh: { stride: 3, count: 0, array: [] } };

    const positionCount = Math.floor(positions.length / 3);
    const correctedPositions = new Array(positionCount);

    for (let i = 0; i < positionCount; i++) {
        const source = new THREE.Vector3(
            positions[i * 3] || 0,
            positions[i * 3 + 1] || 0,
            positions[i * 3 + 2] || 0
        );
        source.applyQuaternion(EF_MATRIX_ROOT_AXIS_CORRECTION).multiplyScalar(GLTF_IMPORT_UNIT_SCALE);
        correctedPositions[i] = [
            roundNumber(source.x, 6),
            roundNumber(source.y, 6),
            roundNumber(source.z, 6)
        ];
    }

    // 所有 parts 合并到单个 Mesh, 与导出逻辑保持对称
    // EpicFight 的 parts 共享同一套 positions/uvs/normals, 只是按 vertex group 分组的三角形索引
    const localVertexMap = {};
    const localPositions = [];
    const localPolygons = [];
    const localVertexWeights = {};
    // 用 Project.getUVWidth/Height 代替 Project.texture_width/height
    // per_texture_uv_size 格式下, getBoundingRect() 用 texture.getUVWidth() 作为 min_x 初始值
    // 如果 texW 和 texture.uv_width 不一致, UV 超出范围时 min_x 会被钳制, 导致 UV 框大小异常
    var texW = (typeof Project !== 'undefined' && typeof Project.getUVWidth === 'function')
        ? Project.getUVWidth() : ((typeof Project !== 'undefined' && Project.texture_width) || 16);
    var texH = (typeof Project !== 'undefined' && typeof Project.getUVHeight === 'function')
        ? Project.getUVHeight() : ((typeof Project !== 'undefined' && Project.texture_height) || 16);

    function ensureLocalVertex(globalIndex) {
        if (localVertexMap[globalIndex] !== undefined) {
            return localVertexMap[globalIndex];
        }
        const localIndex = localPositions.length / 3;
        const corrected = correctedPositions[globalIndex];
        if (!corrected) {
            throw new Error('Mesh references invalid position index: ' + globalIndex);
        }
        localVertexMap[globalIndex] = localIndex;
        localPositions.push(corrected[0], corrected[1], corrected[2]);
        if (vertexWeights[globalIndex]) {
            localVertexWeights[localIndex] = vertexWeights[globalIndex].map(entry => ({
                boneName: entry.boneName,
                weight: entry.weight
            }));
        }
        return localIndex;
    }

    for (const [partName, partData] of Object.entries(parts)) {
        if (!partData || !Array.isArray(partData.array) || partData.array.length < 9) continue;

        const array = partData.array;
        const triangleCount = Math.floor(array.length / 9);
        for (let triIndex = 0; triIndex < triangleCount; triIndex++) {
            const base = triIndex * 9;
            const faceVertices = [];
            const faceUvs = [];

            for (let corner = 0; corner < 3; corner++) {
                const tripleIndex = base + corner * 3;
                const positionIndex = Math.floor(Number(array[tripleIndex]) || 0);
                const uvIndex = Math.floor(Number(array[tripleIndex + 1]) || 0);
                faceVertices.push(ensureLocalVertex(positionIndex));

                const u = uvs[uvIndex * 2];
                const v = uvs[uvIndex * 2 + 1];
                // EpicFight JSON: 归一化 UV (0-1), V=0 在顶部
                // Blockbench MeshFace: 像素 UV (0 ~ texture_width/height), V=0 在顶部
                // 两者 V 方向一致, 只需把归一化坐标乘以纹理尺寸转换为像素坐标
                faceUvs.push([
                    roundNumber(u === undefined ? 0 : (Number(u) || 0) * texW, 6),
                    roundNumber(v === undefined ? 0 : (Number(v) || 0) * texH, 6)
                ]);
            }

            localPolygons.push({
                vertices: faceVertices,
                uvs: faceUvs
            });
        }
    }

    if (!localPolygons.length) {
        throw new Error('EpicFight mesh JSON contains no importable parts.');
    }

    const meshes = [{
        name: fileName + '_Mesh',
        positions: localPositions,
        polygons: localPolygons,
        vertexWeights: localVertexWeights
    }];

    return meshes;
}

function convertEFMeshToBB(data, fileName) {
    const vertices = getEFMeshVertexContainer(data);
    const positionArray = getEFPackedArray(vertices.positions, 'vertices.positions');
    const vertexCount = Math.floor(positionArray.length / 3);
    const jointNames = data && data.armature && Array.isArray(data.armature.joints)
        ? data.armature.joints.map(name => String(name))
        : [];
    const vcounts = vertices.vcounts && Array.isArray(vertices.vcounts.array)
        ? vertices.vcounts.array
        : [];
    const weights = vertices.weights && Array.isArray(vertices.weights.array)
        ? vertices.weights.array
        : [];
    const vindices = vertices.vindices && Array.isArray(vertices.vindices.array)
        ? vertices.vindices.array
        : [];
    const vertexWeights = buildEFVertexWeights(vertexCount, vcounts, vindices, weights, jointNames);
    const bones = buildEFArmatureBones(data ? data.armature : null);
    const meshes = buildEFMeshObjects(vertices, vertexWeights, String(fileName || 'EpicFightMesh'));

    return {
        meshes: meshes,
        armature: { bones: bones },
        preserveBoneRotation: true,
        metadata: {
            vertexCount: vertexCount,
            weightedVertexCount: Object.keys(vertexWeights).length,
            partCount: meshes.length,
            boneCount: bones.length
        }
    };
}

function convertEFArmatureToBB(data, fileName) {
    const armatureData = data && data.armature && typeof data.armature === 'object'
        ? data.armature
        : data;
    const bones = buildEFArmatureBones(armatureData);
    if (!bones.length) {
        throw new Error('EpicFight armature JSON contains no importable bones.');
    }
    return {
        meshes: [],
        armature: { bones: bones },
        preserveBoneRotation: true,
        metadata: {
            boneCount: bones.length,
            fileName: String(fileName || 'EpicFightArmature')
        }
    };
}

// ============================================================
//  BlockBench Object Creator
// ============================================================

function createBlockBenchFromImportData(importData, fileName) {
    let mesh = null;
    let armature = null;
    const boneMap = {};
    // #region debug-point C:create-start
    debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Create Blockbench start', {
        meshes: importData && importData.meshes ? importData.meshes.length : -1,
        bones: importData && importData.armature && importData.armature.bones ? importData.armature.bones.length : -1,
        fileName: fileName
    });
    // #endregion

    // Create Armature first
    const preserveBoneRotation = !!(importData && importData.preserveBoneRotation);
    if (importData.armature && importData.armature.bones.length > 0) {
        const childBonesByParent = {};
        for (const boneData of importData.armature.bones) {
            const parentName = boneData && boneData.parentName ? String(boneData.parentName) : '';
            if (!parentName) continue;
            if (!childBonesByParent[parentName]) childBonesByParent[parentName] = [];
            childBonesByParent[parentName].push(boneData);
        }
        // #region debug-point C:armature-before-create
        debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Armature before create', {
            boneCount: importData.armature.bones.length
        });
        // #endregion
        armature = new Armature({ name: fileName + '_Armature' }).addTo().init();
        // #region debug-point C:armature-after-create
        debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Armature after create', {
            armatureName: armature && armature.name
        });
        // #endregion

        // Create all bones
        let firstPassCount = 0;
        for (const boneData of importData.armature.bones) {
            const childBones = childBonesByParent[boneData.name] || [];
            const bone = new ArmatureBone({
                name: boneData.name,
                origin: [0, 0, 0],
                rotation: [0, 0, 0],
                width: getImportedBoneDisplayWidth(boneData, childBones),
                length: getImportedBoneDisplayLength(boneData, childBones)
            });

            // ArmatureBone transforms are parent-relative in Blockbench.
            // Using world matrices here causes child bones to inherit transforms twice.
            const matrix = boneData.bindLocalMatrix || boneData.localMatrix || boneData.worldMatrix;
            if (matrix) {
                const pos = new THREE.Vector3();
                const scale = new THREE.Vector3();
                const quat = new THREE.Quaternion();
                matrix.decompose(pos, quat, scale);
                bone.origin = [pos.x, pos.y, pos.z];
                if (preserveBoneRotation) {
                    const eulerOrder = (typeof Format !== 'undefined' && Format && Format.euler_order) || 'ZYX';
                    const euler = new THREE.Euler().setFromQuaternion(quat, eulerOrder);
                    bone.rotation = [
                        THREE.MathUtils.radToDeg(euler.x),
                        THREE.MathUtils.radToDeg(euler.y),
                        THREE.MathUtils.radToDeg(euler.z)
                    ];
                } else {
                    bone.rotation = [0, 0, 0];
                }
            }
            // #region debug-point C:bone-transform-sample
            if (firstPassCount < 3) {
                debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Bone transform sample', {
                    boneName: boneData.name,
                    origin: bone.origin.slice(),
                    rotation: bone.rotation.slice(),
                    hasWorldMatrix: !!boneData.worldMatrix
                });
            }
            // #endregion

            boneMap[boneData.name] = bone;
            firstPassCount++;
            // #region debug-point C:first-bone-pass
            if (firstPassCount === 1 || firstPassCount % 10 === 0) {
                debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Bone first pass progress', {
                    firstPassCount: firstPassCount,
                    boneName: boneData.name
                });
            }
            // #endregion
        }
        // #region debug-point C:first-bone-pass-end
        debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Bone first pass end', {
            firstPassCount: firstPassCount
        });
        // #endregion

        // Second pass: parent bones
        let secondPassCount = 0;
        for (const boneData of importData.armature.bones) {
            const bone = boneMap[boneData.name];
            let parent = (boneData.parentName && boneMap[boneData.parentName]) || armature;
            if (parent === bone) {
                parent = armature;
                // #region debug-point C:self-parent-guard
                debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Self parent guard triggered', {
                    boneName: boneData.name,
                    parentName: boneData.parentName
                });
                // #endregion
            }
            // #region debug-point C:bone-before-init
            if (secondPassCount < 3 || secondPassCount % 10 === 0) {
                debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Bone before init', {
                    secondPassCount: secondPassCount + 1,
                    boneName: boneData.name,
                    parentName: parent && parent.name ? parent.name : 'armature'
                });
            }
            // #endregion
            bone.addTo(parent).init();

            secondPassCount++;
            // #region debug-point C:bone-after-init
            if (secondPassCount <= 3 || secondPassCount % 10 === 0) {
                debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Bone after init', {
                    secondPassCount: secondPassCount,
                    boneName: boneData.name,
                    actualParentName: bone.parent && bone.parent !== 'root' && bone.parent.name ? bone.parent.name : 'root'
                });
            }
            // #endregion
        }
        // #region debug-point C:second-bone-pass-end
        debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Bone second pass end', {
            secondPassCount: secondPassCount
        });
        // #endregion

        // Switch rotation space to global for intuitive Z rotation editing
        if (typeof BarItems !== 'undefined' && BarItems && BarItems.rotation_space && typeof BarItems.rotation_space.change === 'function') {
            BarItems.rotation_space.change('global');
        }
    }

    // Create Meshes
    for (const geo of importData.meshes) {
        // #region debug-point C:mesh-before-create
        debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Mesh before create', {
            meshName: geo.name || (fileName + '_Mesh'),
            positionCount: geo.positions ? geo.positions.length / 3 : 0,
            polygonCount: geo.polygons ? geo.polygons.length : 0,
            targetParent: armature ? armature.name : 'root'
        });
        // #endregion
        mesh = new Blockbench.Mesh({
            name: geo.name || (fileName + '_Mesh'),
            visibility: true
        }).addTo(armature || 'root').init();
        // Blockbench Mesh constructor creates a default cube when no vertices are provided.
        // Clear it before filling imported geometry, otherwise its faces get merged into the import.
        mesh.vertices = {};
        mesh.faces = {};
        mesh.seams = {};
        // #region debug-point C:mesh-after-create
        debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Mesh after create', {
            meshName: mesh && mesh.name,
            parentType: mesh && mesh.parent && mesh.parent !== 'root' ? mesh.parent.type : 'root',
            armatureName: mesh && typeof mesh.getArmature === 'function' && mesh.getArmature() ? mesh.getArmature().name : null
        });
        // #endregion

        // Build vertices
        const posArray = geo.positions;
        if (!posArray || posArray.length < 3) continue;
        const meshMatrix = geo.modelMatrix || null;
        const transformedPositions = [];

        for (let i = 0; i < posArray.length; i += 3) {
            const key = 'v' + (i / 3);
            let x = posArray[i];
            let y = posArray[i + 1];
            let z = posArray[i + 2];
            if (meshMatrix) {
                const transformed = new THREE.Vector3(x, y, z).applyMatrix4(meshMatrix);
                x = transformed.x;
                y = transformed.y;
                z = transformed.z;
            }
            mesh.vertices[key] = [x, y, z];
            transformedPositions.push(x, y, z);
        }
        // #region debug-point C:mesh-bounds-sample
        debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Mesh bounds sample', {
            meshName: mesh.name,
            sourceBounds: computeBoundsFromFlatPositions(posArray),
            transformedBounds: computeBoundsFromFlatPositions(transformedPositions),
            hasModelMatrix: !!geo.modelMatrix
        });
        // #endregion

        // Build faces from polygons
        let createdFaces = 0;
        for (const polygon of geo.polygons) {
            const poly = Array.isArray(polygon) ? polygon : polygon.vertices;
            const polyUvs = Array.isArray(polygon) ? null : polygon.uvs;
            if (!poly || poly.length < 3) continue;
            const uv = {};
            for (let i = 0; i < poly.length; i++) {
                const vi = poly[i];
                const key = 'v' + vi;
                if (polyUvs && polyUvs[i]) {
                    uv[key] = polyUvs[i];
                }
            }
            const faceKeys = poly.map(vi => 'v' + vi);
            const face = new Blockbench.MeshFace(mesh, {
                vertices: faceKeys,
                uv: uv
            });
            mesh.addFaces(face);
            createdFaces++;
            // #region debug-point C:create-heartbeat
            if (createdFaces % 500 === 0) {
                debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Create faces heartbeat', {
                    meshName: mesh.name,
                    createdFaces: createdFaces,
                    vertices: Object.keys(mesh.vertices).length
                });
            }
            // #endregion
        }

        // Assign vertex weights (from top-level vertexWeights map, keyed by vertex index)
        const vw = geo.vertexWeights || importData.vertexWeights || {};
        if (Object.keys(vw).length > 0 && armature) {
            for (const [vIdx, weightList] of Object.entries(vw)) {
                const vKey = 'v' + vIdx;
                for (const w of weightList) {
                    const bone = boneMap[w.boneName];
                    if (bone) {
                        bone.setVertexWeight(mesh, vKey, w.weight);
                    }
                }
            }
        }

        if (mesh.preview_controller) {
            mesh.preview_controller.updateTransform(mesh);
            mesh.preview_controller.updateGeometry(mesh);
            mesh.preview_controller.updateFaces(mesh);
            if (typeof mesh.preview_controller.updateUV === 'function') {
                mesh.preview_controller.updateUV(mesh);
            }
        }
        // #region debug-point C:create-mesh-end
        debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Create mesh end', {
            meshName: mesh.name,
            vertices: Object.keys(mesh.vertices).length,
            faces: Object.keys(mesh.faces || {}).length
        });
        // #endregion
    }

    // #region debug-point C:create-end
    debugReport('C', 'epicfight_export.js:createBlockBenchFromImportData', 'Create Blockbench end', {
        hasMesh: !!mesh,
        hasArmature: !!armature
    });
    // #endregion
    return { mesh, armature };
}

// ============================================================
//  Import helpers
// ============================================================

/**
 * Yield to BlockBench's event loop so the UI doesn't freeze
 */
function yieldToUI(callback) {
    setTimeout(callback, 0);
}

function importEpicFightMesh() {
    Filesystem.importFile({
        type: 'EpicFight Mesh JSON',
        extensions: ['json'],
        readtype: 'text',
        resource_id: 'epicfight_mesh',
        title: tl('ef.select_mesh')
    }, function(files) {
        if (!files || !files.length) return;
        const file = files[0];
        let parsed;

        try {
            const content = typeof file.content === 'string' ? file.content : '';
            parsed = JSON.parse(content);
        } catch (e) {
            Blockbench.showMessageBox({
                title: tl('ef.err.mesh_import'),
                icon: 'error',
                message: tl('ef.err.parse_mesh') + ': ' + (e.message || String(e))
            });
            console.error(e);
            return;
        }

        yieldToUI(function() {
            try {
                const baseName = file.name.replace(/\.json$/i, '');
                const importData = convertEFMeshToBB(parsed, baseName);
                createBlockBenchFromImportData(importData, baseName);
                const meta = importData.metadata || {};
                const weightInfo = meta.weightedVertexCount
                    ? (' ' + meta.weightedVertexCount + ' weighted vertices.')
                    : ' No vertex weights found.';
                Blockbench.showToastNotification({
                    text: tl('ef.msg.mesh_imported') + ': ' + file.name + ' (' + (meta.partCount || 0) + ' parts, ' + (meta.boneCount || 0) + ' bones).' + weightInfo,
                    color: meta.boneCount ? 'green' : 'orange',
                    icon: meta.boneCount ? 'check' : 'warning'
                });
            } catch (e) {
                Blockbench.showMessageBox({
                    title: tl('ef.err.mesh_import'),
                    icon: 'error',
                    message: e.message || String(e)
                });
                console.error(e);
            }
        });
    });
}

function importEpicFightArmature() {
    Filesystem.importFile({
        type: 'EpicFight Armature JSON',
        extensions: ['json'],
        readtype: 'text',
        resource_id: 'epicfight_armature',
        title: tl('ef.select_armature')
    }, function(files) {
        if (!files || !files.length) return;
        const file = files[0];
        let parsed;

        try {
            const content = typeof file.content === 'string' ? file.content : '';
            parsed = JSON.parse(content);
        } catch (e) {
            Blockbench.showMessageBox({
                title: tl('ef.err.armature_import'),
                icon: 'error',
                message: tl('ef.err.parse_armature') + ': ' + (e.message || String(e))
            });
            console.error(e);
            return;
        }

        yieldToUI(function() {
            try {
                const baseName = file.name.replace(/\.json$/i, '');
                const importData = convertEFArmatureToBB(parsed, baseName);
                createBlockBenchFromImportData(importData, baseName);
                const meta = importData.metadata || {};
                Blockbench.showToastNotification({
                    text: tl('ef.msg.armature_imported') + ': ' + file.name + ' (' + (meta.boneCount || 0) + ' bones).',
                    color: 'green',
                    icon: 'check'
                });
            } catch (e) {
                Blockbench.showMessageBox({
                    title: tl('ef.err.armature_import'),
                    icon: 'error',
                    message: e.message || String(e)
                });
                console.error(e);
            }
        });
    });
}

function ensureAnimateMode() {
    if (typeof Modes !== 'undefined' && Modes && !Modes.animate && Modes.options && Modes.options.animate) {
        Modes.options.animate.select();
    }
}

function parseEFMatrix(matrixValues) {
    if (!Array.isArray(matrixValues) || matrixValues.length < 16) {
        throw new Error('Invalid EpicFight matrix transform.');
    }
    return new THREE.Matrix4().set(
        Number(matrixValues[0]) || 0, Number(matrixValues[1]) || 0, Number(matrixValues[2]) || 0, Number(matrixValues[3]) || 0,
        Number(matrixValues[4]) || 0, Number(matrixValues[5]) || 0, Number(matrixValues[6]) || 0, Number(matrixValues[7]) || 0,
        Number(matrixValues[8]) || 0, Number(matrixValues[9]) || 0, Number(matrixValues[10]) || 0, Number(matrixValues[11]) || 0,
        Number(matrixValues[12]) || 0, Number(matrixValues[13]) || 0, Number(matrixValues[14]) || 0, Number(matrixValues[15]) || 0
    );
}

function isEpicFightCoordEntry(entry) {
    return !!(entry && typeof entry.name === 'string' && entry.name.toLowerCase() === 'coord');
}

const EF_COORD_PREVIEW_NAME = '_EF_Coord_Preview';

function interpolateEFMatrices(matrixAValues, matrixBValues, alpha) {
    const matrixA = parseEFMatrix(matrixAValues);
    const matrixB = parseEFMatrix(matrixBValues);
    const posA = new THREE.Vector3();
    const posB = new THREE.Vector3();
    const quatA = new THREE.Quaternion();
    const quatB = new THREE.Quaternion();
    const scaleA = new THREE.Vector3();
    const scaleB = new THREE.Vector3();
    matrixA.decompose(posA, quatA, scaleA);
    matrixB.decompose(posB, quatB, scaleB);
    return new THREE.Matrix4().compose(
        posA.lerp(posB, alpha),
        quatA.slerp(quatB, alpha),
        scaleA.lerp(scaleB, alpha)
    );
}

function sampleEpicFightMatrixEntryAtTime(entry, time) {
    if (!entry) return null;
    const times = Array.isArray(entry.time) ? entry.time : [];
    const transforms = Array.isArray(entry.transform) ? entry.transform : [];
    const count = Math.min(times.length, transforms.length);
    if (!count) return null;
    if (count === 1) return parseEFMatrix(transforms[0]);

    const targetTime = Number(time) || 0;
    const epsilon = 1e-4;
    for (let i = 0; i < count; i++) {
        const currentTime = Number(times[i]) || 0;
        if (Math.abs(currentTime - targetTime) <= epsilon) {
            return parseEFMatrix(transforms[i]);
        }
    }
    if (targetTime <= (Number(times[0]) || 0)) return parseEFMatrix(transforms[0]);
    if (targetTime >= (Number(times[count - 1]) || 0)) return parseEFMatrix(transforms[count - 1]);

    for (let i = 0; i < count - 1; i++) {
        const timeA = Number(times[i]) || 0;
        const timeB = Number(times[i + 1]) || 0;
        if (targetTime < timeA || targetTime > timeB) continue;
        const span = timeB - timeA;
        if (span <= epsilon) return parseEFMatrix(transforms[i + 1]);
        return interpolateEFMatrices(transforms[i], transforms[i + 1], (targetTime - timeA) / span);
    }
    return parseEFMatrix(transforms[count - 1]);
}

function getMatrixTranslation(matrix) {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    return position;
}

function ensureEpicFightCoordPreview(armature) {
    if (!armature) return null;
    let preview = null;
    for (const child of armature.children || []) {
        if (child.name !== EF_COORD_PREVIEW_NAME) continue;
        if (child instanceof Group) {
            preview = child;
            break;
        }
        if (typeof child.remove === 'function') {
            child.remove(false);
        }
    }
    if (!preview) {
        preview = new Group({
            name: EF_COORD_PREVIEW_NAME,
            origin: [0, 0, 0],
            rotation: [0, 0, 0],
            export: false
        }).addTo(armature).init();
    }
    if (preview.mesh && preview.mesh.fix_position) {
        preview.mesh.fix_position.set(0, 0, 0);
    }
    if (preview.mesh && preview.mesh.fix_rotation) {
        preview.mesh.fix_rotation.set(0, 0, 0);
    }
    return preview;
}

function removeEpicFightCoordPreview(armature) {
    if (!armature) return;
    for (const child of [...(armature.children || [])]) {
        if (child && child.name === EF_COORD_PREVIEW_NAME && typeof child.remove === 'function') {
            child.remove(false);
        }
    }
}

function getCoordPreviewPositionFromMatrix(matrix, basePosition) {
    const position = getMatrixTranslation(matrix).applyQuaternion(EF_MATRIX_ROOT_AXIS_CORRECTION).multiplyScalar(GLTF_IMPORT_UNIT_SCALE);
    if (basePosition) {
        position.sub(basePosition);
    }
    return [roundNumber(position.x, 6), roundNumber(position.y, 6), roundNumber(position.z, 6)];
}

function quaternionToEulerDegrees(quaternion) {
    const euler = new THREE.Euler().setFromQuaternion(quaternion, getEulerOrder());
    return [
        roundNumber(THREE.MathUtils.radToDeg(euler.x), 6),
        roundNumber(THREE.MathUtils.radToDeg(euler.y), 6),
        roundNumber(THREE.MathUtils.radToDeg(euler.z), 6)
    ];
}

function makeQuaternionFromRotationValue(rot) {
    if (Array.isArray(rot) && rot.length >= 4) {
        // EpicFight attributes 格式: JSON rot = (w, x, y, z), 加载时对 x/y/z 取负
        // 参考: JsonAssetLoader.java:538-541, 792-795 (对 rotArray 1/2/3 取负)
        return new THREE.Quaternion(
            -(Number(rot[1]) || 0),
            -(Number(rot[2]) || 0),
            -(Number(rot[3]) || 0),
            rot[0] === undefined ? 1 : (Number(rot[0]) || 0)
        );
    }
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad((rot && rot[0]) || 0),
        THREE.MathUtils.degToRad((rot && rot[1]) || 0),
        THREE.MathUtils.degToRad((rot && rot[2]) || 0),
        getEulerOrder()
    ));
}

function unwrapEulerDegrees(previous, current) {
    if (!previous) return current.slice();
    const result = current.slice();
    for (let i = 0; i < 3; i++) {
        while (result[i] - previous[i] > 180) result[i] -= 360;
        while (result[i] - previous[i] < -180) result[i] += 360;
        result[i] = roundNumber(result[i], 6);
    }
    return result;
}

function getBoneRestTransform(bone) {
    const sceneObject = bone && bone.scene_object;
    return {
        position: sceneObject && sceneObject.fix_position
            ? sceneObject.fix_position.clone()
            : new THREE.Vector3().fromArray(bone.origin || [0, 0, 0]),
        rotation: sceneObject && sceneObject.fix_rotation
            ? new THREE.Quaternion().setFromEuler(sceneObject.fix_rotation.clone())
            : new THREE.Quaternion().setFromEuler(new THREE.Euler(
                THREE.MathUtils.degToRad((bone.rotation && bone.rotation[0]) || 0),
                THREE.MathUtils.degToRad((bone.rotation && bone.rotation[1]) || 0),
                THREE.MathUtils.degToRad((bone.rotation && bone.rotation[2]) || 0),
                getEulerOrder()
            ))
    };
}

function getBoneRestEulerDegrees(bone) {
    const sceneObject = bone && bone.scene_object;
    if (sceneObject && sceneObject.fix_rotation) {
        return [
            roundNumber(THREE.MathUtils.radToDeg(sceneObject.fix_rotation.x || 0), 6),
            roundNumber(THREE.MathUtils.radToDeg(sceneObject.fix_rotation.y || 0), 6),
            roundNumber(THREE.MathUtils.radToDeg(sceneObject.fix_rotation.z || 0), 6)
        ];
    }
    if (bone && Array.isArray(bone.rotation)) {
        return [
            roundNumber(Number(bone.rotation[0]) || 0, 6),
            roundNumber(Number(bone.rotation[1]) || 0, 6),
            roundNumber(Number(bone.rotation[2]) || 0, 6)
        ];
    }
    return [0, 0, 0];
}

function transformToAnimationChannels(transform, bone, options) {
    // keyframe 存储 euler(source) - euler(rest) (欧拉角相减).
    // Blockbench interpolate() (quaternion_interpolation=true) 流程:
    //   getFixed() = rest × setFromEuler(keyframe)  →  Q1
    //   interpolate() = euler(Q1) - rest_euler       →  arr
    //   displayRotation() = rest_euler + arr          →  bone.rotation
    // 最终 bone.rotation = rest_euler + euler(rest × setFromEuler(keyframe)) - rest_euler
    //                     = euler(rest × setFromEuler(keyframe))
    // 用欧拉角相减时, setFromEuler(euler(source) - euler(rest)) ≈ rest⁻¹ × source (非 gimbal lock 区域),
    // 因此 bone.rotation ≈ euler(rest × rest⁻¹ × source) = euler(source), 预览正确.
    const rest = getBoneRestTransform(bone);
    const restEuler = getBoneRestEulerDegrees(bone);
    if (Array.isArray(transform) || transform instanceof THREE.Matrix4) {
        let matrix = transform instanceof THREE.Matrix4 ? transform.clone() : parseEFMatrix(transform);
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        matrix.decompose(pos, quat, scale);
        const isRootBone = !(bone && bone.parent instanceof ArmatureBone);
        if (isRootBone) {
            const rootAxisCorrection = (options && options.rootAxisCorrection) || EF_MATRIX_ROOT_AXIS_CORRECTION;
            pos.applyQuaternion(rootAxisCorrection);
            quat.premultiply(rootAxisCorrection);
        }
        pos.multiplyScalar(GLTF_IMPORT_UNIT_SCALE);
        const sourceEuler = quaternionToEulerDegrees(quat);
        const deltaEuler = [
            roundNumber(sourceEuler[0] - restEuler[0], 6),
            roundNumber(sourceEuler[1] - restEuler[1], 6),
            roundNumber(sourceEuler[2] - restEuler[2], 6)
        ];
        const deltaPos = pos.sub(rest.position);
        return {
            position: [roundNumber(deltaPos.x, 6), roundNumber(deltaPos.y, 6), roundNumber(deltaPos.z, 6)],
            rotation: deltaEuler,
            scale: [1, 1, 1]
        };
    }
    if (transform && typeof transform === 'object') {
        const rotationQuat = makeQuaternionFromRotationValue(transform.rot);
        const targetQuat = rest.rotation.clone().multiply(rotationQuat);
        const targetEuler = quaternionToEulerDegrees(targetQuat);
        const deltaEuler = [
            roundNumber(targetEuler[0] - restEuler[0], 6),
            roundNumber(targetEuler[1] - restEuler[1], 6),
            roundNumber(targetEuler[2] - restEuler[2], 6)
        ];
        // EpicFight ATTRIBUTES loc = rest local space delta, EpicFight 单位
        // 转换到 Blockbench parent space delta: loc × rest.rotation × GLTF_UNIT
        // 与导出 decomposeAnimatedMatrixToEFAttributesTransform 对称
        const locArr = Array.isArray(transform.loc) ? transform.loc.map(v => Number(v) || 0) : [0, 0, 0];
        const locVec = new THREE.Vector3(locArr[0], locArr[1], locArr[2])
            .applyQuaternion(rest.rotation)
            .multiplyScalar(GLTF_IMPORT_UNIT_SCALE);
        return {
            position: [roundNumber(locVec.x, 6), roundNumber(locVec.y, 6), roundNumber(locVec.z, 6)],
            rotation: deltaEuler,
            scale: toFixedArray(Array.isArray(transform.sca) ? transform.sca.map(v => Number(v) || 0) : [1, 1, 1])
        };
    }
    throw new Error('Unsupported EpicFight transform entry.');
}

function createTransformKeyframe(animator, channel, time, values) {
    const roundedValues = {
        x: roundNumber(Number(values[0]) || 0, 6),
        y: roundNumber(Number(values[1]) || 0, 6),
        z: roundNumber(Number(values[2]) || 0, 6)
    };
    return animator.createKeyframe(roundedValues, time, channel, false, false);
}

function getEpicFightAnimationEntries(data) {
    if (Array.isArray(data)) {
        return data;
    }
    if (!data || typeof data !== 'object') {
        return null;
    }
    if (Array.isArray(data.animation)) {
        return data.animation;
    }
    if (data.animation && typeof data.animation === 'object' && Array.isArray(data.animation.animation)) {
        return data.animation.animation;
    }
    if (data.data && typeof data.data === 'object' && Array.isArray(data.data.animation)) {
        return data.data.animation;
    }
    return null;
}

function describeJsonRoot(data) {
    if (Array.isArray(data)) {
        return 'root is an array';
    }
    if (!data || typeof data !== 'object') {
        return 'root type is ' + typeof data;
    }
    const keys = Object.keys(data);
    return keys.length ? ('root keys: ' + keys.slice(0, 12).join(', ')) : 'root object has no keys';
}

function getUniqueAnimationName(baseName) {
    const preferredName = String(baseName || 'Imported Animation').trim() || 'Imported Animation';
    const existingNames = new Set((Animation && Animation.all ? Animation.all : []).map(anim => String((anim && anim.name) || '').toLowerCase()));
    if (!existingNames.has(preferredName.toLowerCase())) {
        return preferredName;
    }
    let index = 2;
    let candidate = preferredName + ' (' + index + ')';
    while (existingNames.has(candidate.toLowerCase())) {
        index++;
        candidate = preferredName + ' (' + index + ')';
    }
    return candidate;
}

function importEpicFightAnimationData(data, fileName, animationNameOverride) {
    const armature = getArmature();
    if (!armature) {
        throw new Error('No armature found in the current Blockbench project.');
    }
    const animationEntries = getEpicFightAnimationEntries(data);
    if (!animationEntries || !animationEntries.length) {
        throw new Error('EpicFight animation JSON has no animation entries. ' + describeJsonRoot(data));
    }
    const coordEntry = animationEntries.find(isEpicFightCoordEntry) || null;
    const ignoreCoordForPreview = !!coordEntry;
    removeEpicFightCoordPreview(armature);
    const coordPreview = null;

    ensureAnimateMode();

    const fps = Math.max(1, Number(data.fps) || 20);
    const boneByName = {};
    for (const bone of getDeformBones(armature)) {
        boneByName[bone.name.toLowerCase()] = bone;
    }

    const animationName = getUniqueAnimationName(animationNameOverride || String(fileName || 'Imported Animation').replace(/\.json$/i, ''));
    const animation = new Animation({
        name: animationName,
        saved_name: animationName,
        saved: false,
        snapping: Math.max(10, Math.min(500, Math.round(fps)))
    }).add(false);

    // Select the imported animation immediately
    Animation.selected = animation;
    animation.selected = true;

    // 保存 Coord 原始数据到 animation 属性, 供导出时根据目标格式转换输出
    // Coord 骨骼存在于动画文件但不存在于 armature 文件, 导入时被跳过,
    // 导出时需保留 (time + transform 数组), 并根据目标格式 (matrix/attributes) 转换
    if (coordEntry) {
        const coordTimes = Array.isArray(coordEntry.time) ? coordEntry.time.slice() : [];
        const coordTransforms = Array.isArray(coordEntry.transform) ? coordEntry.transform.slice() : [];
        animation._ef_coord_data = {
            time: coordTimes,
            transform: coordTransforms
        };
    } else {
        animation._ef_coord_data = null;
    }

    const createdKeyframes = [];
    const missingBones = [];
    let coordBasePosition = null;
    let maxTime = 0;

    // Pre-create all animators upfront to avoid lazy initialization in the main loop
    for (const entry of animationEntries) {
        if (!entry || !entry.name || isEpicFightCoordEntry(entry)) continue;
        const bone = boneByName[String(entry.name).toLowerCase()];
        if (!bone) continue;
        const animator = animation.getBoneAnimator(bone);
        // 启用四元数 slerp 插值, 避免欧拉角线性插值在 gimbal lock 附近产生抽搐旋转
        animator.quaternion_interpolation = true;
        // ArmatureBoneAnimator.doRender() 只设 this.element 不设 this.group,
        // 但 quaternion_interpolation=true 时, interpolate()/getFixed() 访问 this.group
        // 直接设 animator.group = bone (ArmatureBone 节点), 不依赖 doRender() 或 patch
        if (!animator.group) animator.group = bone;
    }

    // Estimate animation length upfront so the timeline doesn't resize during keyframe creation
    let estimatedMaxTime = 0;
    for (const entry of animationEntries) {
        if (!entry || !entry.time) continue;
        const times = Array.isArray(entry.time) ? entry.time : [];
        for (const t of times) {
            const num = Number(t);
            if (num > estimatedMaxTime) estimatedMaxTime = num;
        }
    }
    if (estimatedMaxTime > 0) {
        animation.setLength(estimatedMaxTime);
    }

    try {
        if (coordEntry && coordPreview) {
            const coordTimes = Array.isArray(coordEntry.time) ? coordEntry.time : [];
            const coordTransforms = Array.isArray(coordEntry.transform) ? coordEntry.transform : [];
            const coordCount = Math.min(coordTimes.length, coordTransforms.length);
            const coordAnimator = animation.getBoneAnimator(coordPreview);
            const coordBaseMatrix = coordCount ? parseEFMatrix(coordTransforms[0]) : null;
            coordBasePosition = coordBaseMatrix
                ? getMatrixTranslation(coordBaseMatrix).applyQuaternion(EF_MATRIX_ROOT_AXIS_CORRECTION).multiplyScalar(GLTF_IMPORT_UNIT_SCALE)
                : null;
            if (coordAnimator && coordBasePosition) {
                for (let i = 0; i < coordCount; i++) {
                    const time = roundNumber(Number(coordTimes[i]) || 0, 4);
                    const position = getCoordPreviewPositionFromMatrix(parseEFMatrix(coordTransforms[i]), coordBasePosition);
                    createdKeyframes.push(createTransformKeyframe(coordAnimator, 'position', time, position));
                    if (time > maxTime) maxTime = time;
                }
            }
        }

        // Batch keyframe creation: direct Keyframe construction is much faster than per-keyframe createKeyframe calls
        const perAnimatorKeyframes = {};

        for (const entry of animationEntries) {
            if (!entry || !entry.name) continue;
            if (isEpicFightCoordEntry(entry)) continue;
            const bone = boneByName[String(entry.name).toLowerCase()];
            if (!bone) {
                missingBones.push(String(entry.name));
                continue;
            }

            const times = Array.isArray(entry.time) ? entry.time : [];
            const transforms = Array.isArray(entry.transform) ? entry.transform : [];
            const count = Math.min(times.length, transforms.length);
            if (!count) continue;

            const animator = animation.getBoneAnimator(bone);
            if (!animator) continue;

            if (!perAnimatorKeyframes[animator.uuid]) {
                perAnimatorKeyframes[animator.uuid] = { animator: animator, positions: [], rotations: [] };
            }
            const target = perAnimatorKeyframes[animator.uuid];
            let prevRot = null;

            for (let i = 0; i < count; i++) {
                const t = roundNumber(Number(times[i]) || 0, 4);
                const channels = transformToAnimationChannels(transforms[i], bone, {});
                if (prevRot) {
                    channels.rotation = unwrapEulerDegrees(prevRot, channels.rotation);
                }
                prevRot = channels.rotation.slice();

                target.positions.push({
                    t: t,
                    x: roundNumber(channels.position[0], 6),
                    y: roundNumber(channels.position[1], 6),
                    z: roundNumber(channels.position[2], 6)
                });
                target.rotations.push({
                    t: t,
                    x: roundNumber(channels.rotation[0], 6),
                    y: roundNumber(channels.rotation[1], 6),
                    z: roundNumber(channels.rotation[2], 6)
                });
                if (t > maxTime) maxTime = t;
            }
        }

        // Batch-create all Keyframe objects and push to animator channel arrays
        // NOTE: animator.keyframes is a getter that concatenates channel arrays — we push to channel arrays only
        // 关键优化: 用 push(...batch) 批量添加, 避免逐个 push 触发 Vue 响应式重渲染
        // Timeline.vue 模板有 v-for="keyframe in animator[channel]", 每次 push 都会触发时间轴重渲染
        // 逐个 push: N骨骼 × M关键帧 × 2通道 = 数千次 Vue 重渲染 (卡顿根源)
        // 批量 push: 每个通道只触发 1 次 Vue 更新
        const animatorUuids = Object.keys(perAnimatorKeyframes);

        for (const uuid of animatorUuids) {
            const entry = perAnimatorKeyframes[uuid];
            const animator = entry.animator;
            if (!animator.position) animator.position = [];
            if (!animator.rotation) animator.rotation = [];

            // 先在临时数组中构建所有 Keyframe 对象, 再一次性 push
            const posKfs = entry.positions.map(function(pos) {
                return new Blockbench.Keyframe({
                    channel: 'position',
                    x: pos.x, y: pos.y, z: pos.z,
                    time: pos.t
                }, null, animator);
            });
            const rotKfs = entry.rotations.map(function(rot) {
                return new Blockbench.Keyframe({
                    channel: 'rotation',
                    x: rot.x, y: rot.y, z: rot.z,
                    time: rot.t
                }, null, animator);
            });

            // 批量 push: 每个通道只触发 1 次 Vue 响应式更新
            if (posKfs.length) animator.position.push.apply(animator.position, posKfs);
            if (rotKfs.length) animator.rotation.push.apply(animator.rotation, rotKfs);
            createdKeyframes.push.apply(createdKeyframes, posKfs);
            createdKeyframes.push.apply(createdKeyframes, rotKfs);

            animator.position.sort((a, b) => a.time - b.time);
            animator.rotation.sort((a, b) => a.time - b.time);
            if (!animator._efInterpPtr) animator._efInterpPtr = {};
            animator._efInterpPtr.position = 0;
            animator._efInterpPtr.rotation = 0;
            animator.addToTimeline();
        }

        if (!createdKeyframes.length) {
            animation.remove(false, false);
            throw new Error('No matching animation keyframes could be imported for the current armature.');
        }

        animation.setLength(maxTime);

        // 方案 A: 不再在此处立即调用 Animator.preview()
        // 改由上层 importEpicFightAnimation 在所有文件导入完成后统一延迟预览
        // 这样: (1) 多文件导入时只预览一次; (2) UI 先更新时间轴/toast, 避免界面冻结
    } catch (e) {
        console.error('Animation import error:', e);
        animation.remove(false, false);
        throw e;
    }

    return {
        animation: animation,
        importedBones: animationEntries.length - missingBones.length,
        missingBones: missingBones,
        keyframeCount: createdKeyframes.length,
        fps: fps,
        hasCoordPreview: !!coordEntry,
        ignoredCoord: ignoreCoordForPreview,
        needPreview: true
    };
}

function importEpicFightAnimation() {
    Filesystem.importFile({
        type: 'EpicFight Animation JSON',
        extensions: ['json'],
        readtype: 'text',
        multiple: true,
        resource_id: 'epicfight_animation',
        title: tl('ef.select_animation')
    }, function(files) {
        if (!files || !files.length) return;

        // 方案 B: 导入开始时显示进度提示
        if (typeof Blockbench !== 'undefined' && Blockbench.showQuickMessage) {
            Blockbench.showQuickMessage(tl('ef.msg.importing_anim') + (files.length > 1 ? ' (' + files.length + ' ' + tl('ef.msg.files') + ')' : '') + '...', 3000);
        }

        yieldToUI(function() {
            const importedResults = [];
            const errors = [];
            let hadIgnoredCoord = false;
            let needPreview = false;

            for (const file of files) {
                try {
                    const content = typeof file.content === 'string' ? file.content : '';
                    const parsed = JSON.parse(content);
                    const result = importEpicFightAnimationData(parsed, file.name);
                    importedResults.push({
                        fileName: file.name,
                        result: result
                    });
                    if (result.ignoredCoord) hadIgnoredCoord = true;
                    if (result.needPreview) needPreview = true;
                } catch (e) {
                    errors.push({
                        fileName: file && file.name ? file.name : 'Unknown File',
                        message: e && e.message ? e.message : String(e)
                    });
                    console.error(e);
                }
            }

            if (!importedResults.length) {
                Blockbench.showMessageBox({
                    title: tl('ef.err.anim_import'),
                    icon: 'error',
                    message: errors.length
                        ? errors.map(error => error.fileName + ': ' + error.message).join('\n')
                        : tl('ef.err.no_anim_files')
                });
                return;
            }

            const totalKeyframes = importedResults.reduce((sum, item) => sum + (item.result.keyframeCount || 0), 0);
            const filesWithMissingBones = importedResults.filter(item => item.result.missingBones && item.result.missingBones.length);
            Blockbench.showToastNotification({
                text: importedResults.length + ' ' + tl('ef.msg.anim_imported') + ' (' + totalKeyframes + ' ' + tl('ef.msg.keyframes') + ').' +
                    (filesWithMissingBones.length ? ' ' + filesWithMissingBones.length + ' ' + tl('ef.msg.have_missing_bones') + '.' : '') +
                    (errors.length ? ' ' + errors.length + ' ' + tl('ef.msg.file_failed') + '.' : ''),
                color: filesWithMissingBones.length || errors.length ? 'orange' : 'green',
                icon: filesWithMissingBones.length || errors.length ? 'warning' : 'check'
            });

            if (filesWithMissingBones.length || errors.length || hadIgnoredCoord) {
                const detailLines = [];
                importedResults.forEach(item => {
                    const missingInfo = item.result.missingBones.length
                        ? ' ' + tl('ef.msg.missing_bones') + ': ' + item.result.missingBones.slice(0, 6).join(', ') + (item.result.missingBones.length > 6 ? '...' : '')
                        : '';
                    const coordInfo = item.result.ignoredCoord ? ' ' + tl('ef.msg.coord_ignored') : '';
                    detailLines.push(item.fileName + ': ' + item.result.keyframeCount + ' keyframes.' + missingInfo + coordInfo);
                });
                errors.forEach(error => {
                    detailLines.push(error.fileName + ': ' + error.message);
                });
                if (hadIgnoredCoord) {
                    detailLines.push(tl('ef.msg.coord_preview_mode'));
                }
                Blockbench.showMessageBox({
                    title: tl('ef.summary.anim_import'),
                    icon: errors.length ? 'warning' : 'info',
                    message: detailLines.join('\n')
                });
            }

            // 预览第 0 帧, 让 3D 视图立即显示动画起始姿势
            if (needPreview && typeof Animator !== 'undefined' && Animator && typeof Animator.preview === 'function') {
                try {
                    Animator.preview();
                } catch (e) {
                    console.error('Preview error:', e);
                }
            }
            // 自动播放: 多文件导入时每个动画都 addToTimeline, 导致 Timeline.animators 堆积。
            // 保留最后一个动画的 animators, 移除其他的, 避免播放时多动画叠加。
            if (needPreview && typeof Timeline !== 'undefined' && Timeline && typeof Timeline.start === 'function') {
                var lastAnimation = importedResults.length
                    ? importedResults[importedResults.length - 1].result.animation
                    : null;
                var startPlayback = function() {
                    try {
                        // 重置所有动画的 playing 状态
                        if (typeof Animation !== 'undefined' && Animation.all) {
                            Animation.all.forEach(function(a) { a.playing = false; });
                        }
                        // 清空 Timeline.animators 后只重新加入最后一个动画的 animator
                        // 不能用 uuid 过滤: 不同动画的同骨骼 animator 共享同一 group.uuid, 无法区分
                        if (lastAnimation) {
                            Timeline.animators.length = 0;  // 清空数组
                            if (lastAnimation.animators) {
                                for (var k in lastAnimation.animators) {
                                    var an = lastAnimation.animators[k];
                                    if (an && typeof an.addToTimeline === 'function') {
                                        an.addToTimeline();
                                    }
                                }
                            }
                            Animation.all.forEach(function(a) { a.selected = false; });
                            lastAnimation.selected = true;
                            Animation.selected = lastAnimation;
                            lastAnimation.playing = true;
                        }
                        if (typeof Timeline.setTime === 'function') Timeline.setTime(0);
                        try {
                            Timeline.start();
                        } catch (startErr) {
                            console.error('Autoplay start error:', startErr);
                        }
                    } catch (e) {
                        console.error('Autoplay error:', e);
                    }
                };
                if (typeof Vue !== 'undefined' && Vue.nextTick) {
                    Vue.nextTick(function() { setTimeout(startPlayback, 50); });
                } else {
                    setTimeout(startPlayback, 100);
                }
            }
        });
    });
}

// ============================================================
//  Geometry helpers (for EF JSON export)
// ============================================================

function vec3Key(v) {
    return v.map(c => Math.round(c * 1e4) / 1e4);
}

function computeFaceNormal(v0, v1, v2) {
    const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
    const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-10) { nx /= len; ny /= len; nz /= len; }
    return [nx, ny, nz];
}

// ============================================================
//  Project Data Accessors
// ============================================================

function getAllMeshes() {
    const meshes = [];
    function walk(node) {
        if (node instanceof Blockbench.Mesh) {
            meshes.push(node);
        }
        if (node.children) node.children.forEach(walk);
    }
    if (Project && Project.outliner) Project.outliner.forEach(walk);
    return meshes;
}

function getPartNameForElement(element) {
    let parent = element.parent;
    while (parent) {
        if (parent instanceof Group) {
            return parent.name;
        }
        parent = parent.parent;
    }
    return 'noGroups';
}

function getAllElements() {
    const elements = [];
    function walk(node) {
        if (node instanceof Cube || node instanceof Blockbench.Mesh) {
            elements.push(node);
        }
        if (node.children) node.children.forEach(walk);
    }
    if (Project && Project.outliner) Project.outliner.forEach(walk);
    return elements;
}

var CUBE_FACE_DEFS = {
    north: { corners: [0, 1, 2, 3], normal: [0, 0, -1] },
    south: { corners: [4, 5, 6, 7], normal: [0, 0, 1] },
    east:  { corners: [1, 5, 6, 2], normal: [1, 0, 0] },
    west:  { corners: [0, 4, 7, 3], normal: [-1, 0, 0] },
    up:    { corners: [3, 2, 6, 7], normal: [0, 1, 0] },
    down:  { corners: [0, 1, 5, 4], normal: [0, -1, 0] }
};

function getCubeCorners(cube) {
    var from = cube.from;
    var to = cube.to;
    var corners = [
        [from[0], from[1], from[2]],
        [to[0],   from[1], from[2]],
        [to[0],   to[1],   from[2]],
        [from[0], to[1],   from[2]],
        [from[0], from[1], to[2]],
        [to[0],   from[1], to[2]],
        [to[0],   to[1],   to[2]],
        [from[0], to[1],   to[2]]
    ];

    var rotation = cube.rotation;
    if (rotation && (rotation[0] || rotation[1] || rotation[2])) {
        var origin = cube.origin || [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
        var euler = new THREE.Euler(
            THREE.MathUtils.degToRad(rotation[0] || 0),
            THREE.MathUtils.degToRad(rotation[1] || 0),
            THREE.MathUtils.degToRad(rotation[2] || 0),
            getEulerOrder()
        );
        var quat = new THREE.Quaternion().setFromEuler(euler);
        for (var i = 0; i < corners.length; i++) {
            var v = new THREE.Vector3(corners[i][0] - origin[0], corners[i][1] - origin[1], corners[i][2] - origin[2]);
            v.applyQuaternion(quat);
            corners[i] = [v.x + origin[0], v.y + origin[1], v.z + origin[2]];
        }
    }

    return corners;
}

function getArmature() {
    if (!Project || !Project.outliner) return null;
    for (let i = 0; i < Project.outliner.length; i++) {
        if (Project.outliner[i] instanceof Armature) return Project.outliner[i];
    }
    return null;
}

function getDeformBones(armature) {
    const bones = [];
    function walk(node) {
        if (node instanceof ArmatureBone) {
            bones.push(node);
        }
        if (node.children) node.children.forEach(walk);
    }
    if (armature) armature.children.forEach(walk);
    return bones;
}

function getAllBoneNames(armature) {
    return getDeformBones(armature).map(b => b.name);
}

function findDeformParent(bone) {
    let parent = bone.parent;
    while (parent) {
        if (parent instanceof ArmatureBone) return parent;
        parent = parent.parent;
    }
    return null;
}

function findParentBoneForElement(element) {
    let parent = element.parent;
    while (parent) {
        if (parent instanceof ArmatureBone) return parent;
        parent = parent.parent;
    }
    return null;
}

function getEulerOrder() {
    return (typeof Format !== 'undefined' && Format && Format.euler_order) || 'ZYX';
}

const EF_MATRIX_ROOT_AXIS_CORRECTION = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-Math.PI / 2, 0, 0, 'XYZ')
);
const EF_COORD_FILE_ROOT_AXIS_CORRECTION = new THREE.Quaternion();

function getExportFps() {
    if (Animation && Animation.selected) {
        return getAnimationFps(Animation.selected);
    }
    if (Animation && Animation.all && Animation.all.length) {
        return getAnimationFps(Animation.all[0]);
    }
    return 20.0;
}

function toFixedArray(values, digits = 6) {
    return values.map(value => roundNumber(value, digits));
}

function quaternionToEFArray(quaternion) {
    return [
        roundNumber(quaternion.w, 6),
        roundNumber(quaternion.x, 6),
        roundNumber(quaternion.y, 6),
        roundNumber(quaternion.z, 6)
    ];
}

// EpicFight attributes 格式约定: JSON rot = negate(q_minecraft) = (w, -x, -y, -z)
// EpicFight 加载时对 x/y/z 取负, 得到原始 Minecraft 四元数
// 参考: JsonAssetLoader.java:788-799 (fromPrimitives 对 rotArray 1/2/3 取负)
function quaternionToEFAttributesArray(quaternion) {
    return [
        roundNumber(quaternion.w, 6),
        roundNumber(-quaternion.x, 6),
        roundNumber(-quaternion.y, 6),
        roundNumber(-quaternion.z, 6)
    ];
}

function composeTransformMatrix(loc, rotDeg, sca) {
    const rotation = rotDeg || [0, 0, 0];
    const scale = sca || [1, 1, 1];
    const euler = new THREE.Euler(
        THREE.MathUtils.degToRad(rotation[0] || 0),
        THREE.MathUtils.degToRad(rotation[1] || 0),
        THREE.MathUtils.degToRad(rotation[2] || 0),
        getEulerOrder()
    );
    return new THREE.Matrix4().compose(
        new THREE.Vector3((loc && loc[0]) || 0, (loc && loc[1]) || 0, (loc && loc[2]) || 0),
        new THREE.Quaternion().setFromEuler(euler),
        new THREE.Vector3(scale[0] === undefined ? 1 : scale[0], scale[1] === undefined ? 1 : scale[1], scale[2] === undefined ? 1 : scale[2])
    );
}

function decomposeMatrixToEFTransform(matrix) {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(pos, quat, scale);
    return {
        loc: toFixedArray([pos.x, pos.y, pos.z]),
        rot: quaternionToEFArray(quat),
        sca: toFixedArray([scale.x, scale.y, scale.z])
    };
}

function decomposeBoneLocalRestMatrixToEFTransform(matrix, bone) {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(pos, quat, scale);

    pos.multiplyScalar(1 / GLTF_IMPORT_UNIT_SCALE);

    // attributes 格式 root bone: 对 pos 和 quat 都做 invRootAxis
    // EpicFight 加载: 对 rot 取负 (attributes 约定) + 对 root bone 的 matrix 做 BLENDER_TO_MINECRAFT_COORD (rotX(-90°))
    // 反推: M_json = rotX(+90°) · M_mc, 即 loc = invRootAxis·loc_mc, quat = invRootAxis·q_mc
    // 与 localPoseMatrixToEFMatrixArray (matrix 格式) 保持对称
    const isRootBone = !(bone && bone.parent instanceof ArmatureBone);
    if (isRootBone) {
        const inverseRootAxisCorrection = EF_MATRIX_ROOT_AXIS_CORRECTION.clone().invert();
        pos.applyQuaternion(inverseRootAxisCorrection);
        quat.premultiply(inverseRootAxisCorrection);
    }

    return {
        loc: toFixedArray([pos.x, pos.y, pos.z]),
        rot: quaternionToEFAttributesArray(quat),
        sca: toFixedArray([scale.x, scale.y, scale.z])
    };
}

function decomposeAnimatedMatrixToEFAttributesTransform(matrix, bone) {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(pos, quat, scale);

    const rest = getBoneRestTransform(bone);
    const deltaQuat = rest.rotation.clone().invert().multiply(quat).normalize();

    // translation offset 必须从 parent space 旋转到 rest local space
    // offset_pos = R(rest_rot)⁻¹ × (source_pos - rest_pos)
    // 在左右镜像骨骼 (rest_rot = R(180°Y)) 上, 缺少此变换会导致 X/Z 分量未翻转, 左右手方向相反
    const deltaPos = new THREE.Vector3(
        pos.x - rest.position.x,
        pos.y - rest.position.y,
        pos.z - rest.position.z
    );
    deltaPos.applyQuaternion(rest.rotation.clone().invert());
    deltaPos.multiplyScalar(1 / GLTF_IMPORT_UNIT_SCALE);

    return {
        loc: toFixedArray([deltaPos.x, deltaPos.y, deltaPos.z]),
        rot: quaternionToEFAttributesArray(deltaQuat),
        sca: toFixedArray([scale.x, scale.y, scale.z])
    };
}

function matrixToEFArray(matrix) {
    const te = matrix.elements;
    return toFixedArray([
        te[0], te[4], te[8], te[12],
        te[1], te[5], te[9], te[13],
        te[2], te[6], te[10], te[14],
        te[3], te[7], te[11], te[15]
    ]);
}

function localPoseMatrixToEFMatrixArray(matrix, bone) {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(pos, quat, scale);

    pos.multiplyScalar(1 / GLTF_IMPORT_UNIT_SCALE);

    const isRootBone = !(bone && bone.parent instanceof ArmatureBone);
    if (isRootBone) {
        const inverseRootAxisCorrection = EF_MATRIX_ROOT_AXIS_CORRECTION.clone().invert();
        pos.applyQuaternion(inverseRootAxisCorrection);
        quat.premultiply(inverseRootAxisCorrection);
    }

    return matrixToEFArray(new THREE.Matrix4().compose(pos, quat, scale));
}

function getBoneLocalRestMatrix(bone) {
    return composeTransformMatrix(bone.origin || [0, 0, 0], bone.rotation || [0, 0, 0], [1, 1, 1]);
}

function getBoneAnimatedLocalMatrixAtTime(bone, animator, time) {
    const rest = getBoneRestTransform(bone);
    const position = sampleAnimatorChannel(animator, time, 'position', [0, 0, 0]);
    const scale = sampleAnimatorChannel(animator, time, 'scale', [1, 1, 1]);

    // 重建 source 旋转: keyframe 存储 euler(source) - euler(rest) (见 transformToAnimationChannels).
    // 两种数据来源, 都用欧拉角相加重建: source = setFromEuler(rest_euler + keyframe) = setFromEuler(euler(source)).
    // 必须用欧拉角相加而非四元数相乘 rest × setFromEuler(keyframe), 因为
    // setFromEuler(euler(source) - euler(rest)) ≠ rest⁻¹ × source (gimbal lock 区域, 如镜像骨骼 Y=180°),
    // 用四元数相乘会在左右镜像骨骼上产生方向反转.
    const restEuler = getBoneRestEulerDegrees(bone);
    let rotation;
    const rawRotation = getRawKeyframeRotationAtTime(animator, time);
    if (rawRotation) {
        // keyframe 时间点: 直接读取原始值 euler(source) - euler(rest), 避免 interpolate() 转换
        rotation = rawRotation;
    } else {
        // 非 keyframe 时间点: interpolate() 返回 euler(rest × interpolated_offset) - rest_euler
        // (slerp 插值后的结果), 加 rest_euler 得到 euler(rest × interpolated_offset) = euler(source_at_t)
        rotation = sampleAnimatorChannel(animator, time, 'rotation', [0, 0, 0]);
    }
    const sourceQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad((restEuler[0] || 0) + (rotation[0] || 0)),
        THREE.MathUtils.degToRad((restEuler[1] || 0) + (rotation[1] || 0)),
        THREE.MathUtils.degToRad((restEuler[2] || 0) + (rotation[2] || 0)),
        getEulerOrder()
    ));

    return new THREE.Matrix4().compose(
        new THREE.Vector3(
            rest.position.x + position[0],
            rest.position.y + position[1],
            rest.position.z + position[2]
        ),
        sourceQuat,
        new THREE.Vector3(
            scale[0] === undefined ? 1 : scale[0],
            scale[1] === undefined ? 1 : scale[1],
            scale[2] === undefined ? 1 : scale[2]
        )
    );
}

// 直接读取 keyframe 时间点的原始 offset 旋转值, 绕过 interpolate 的欧拉角转换
function getRawKeyframeRotationAtTime(animator, time) {
    if (!animator || !animator.rotation || !animator.rotation.length) return null;
    const epsilon = 1e-4;
    for (const kf of animator.rotation) {
        if (Math.abs(kf.time - time) <= epsilon) {
            return [
                Number(kf.calc('x', 0)) || 0,
                Number(kf.calc('y', 0)) || 0,
                Number(kf.calc('z', 0)) || 0
            ];
        }
    }
    return null;
}

function sampleAnimatorChannel(animator, time, channel, fallback) {
    if (!animator || !animator[channel] || !animator[channel].length) {
        return fallback.slice();
    }
    const previousTimelineTime = (typeof Timeline !== 'undefined' && Timeline) ? Timeline.time : 0;
    const previousTime = animator.animation.time;
    if (typeof Timeline !== 'undefined' && Timeline) {
        Timeline.time = time;
    }
    animator.animation.time = time;
    let result = animator.interpolate(channel, false);
    animator.animation.time = previousTime;
    if (typeof Timeline !== 'undefined' && Timeline) {
        Timeline.time = previousTimelineTime;
    }
    if (!Array.isArray(result)) {
        return fallback.slice();
    }
    return result.map(value => Number(value) || 0);
}

function roundNumber(value, digits) {
    const n = Number(value) || 0;
    const factor = Math.pow(10, digits);
    return Math.round(n * factor) / factor;
}

function createArrayDict(stride, array, count) {
    return {
        stride: stride,
        count: count === undefined ? Math.floor(array.length / stride) : count,
        array: array
    };
}

function isJsonPrimitive(value) {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function stringifyEpicFightJson(value, indentLevel = 0) {
    const indent = ' '.repeat(indentLevel);
    const childIndentLevel = indentLevel + 4;
    const childIndent = ' '.repeat(childIndentLevel);

    if (isJsonPrimitive(value)) {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        if (!value.length) {
            return '[]';
        }
        const inline = value.every(isJsonPrimitive);
        if (inline) {
            return '[' + value.map(item => JSON.stringify(item)).join(', ') + ']';
        }
        return '[\n' + value.map(item => childIndent + stringifyEpicFightJson(item, childIndentLevel)).join(',\n') + '\n' + indent + ']';
    }

    if (!value || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    const entries = Object.entries(value);
    if (!entries.length) {
        return '{}';
    }

    return '{\n' + entries.map(([key, entryValue]) => {
        return childIndent + JSON.stringify(key) + ': ' + stringifyEpicFightJson(entryValue, childIndentLevel);
    }).join(',\n') + '\n' + indent + '}';
}

function getFaceVertices(face) {
    if (!face) return [];
    if (typeof face.getSortedVertices === 'function') {
        return face.getSortedVertices();
    }
    return face.vertices || [];
}

function getAnimationFps(animation) {
    if (animation && typeof animation.snapping === 'number' && animation.snapping > 0) {
        return animation.snapping;
    }
    return 20.0;
}

function computeBoundsFromFlatPositions(values) {
    if (!values || values.length < 3) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < values.length; i += 3) {
        const x = Number(values[i]) || 0;
        const y = Number(values[i + 1]) || 0;
        const z = Number(values[i + 2]) || 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    return {
        min: [roundNumber(minX, 4), roundNumber(minY, 4), roundNumber(minZ, 4)],
        max: [roundNumber(maxX, 4), roundNumber(maxY, 4), roundNumber(maxZ, 4)]
    };
}

function convertBlockbenchPositionToEF(position) {
    const vector = new THREE.Vector3(
        Number(position[0]) || 0,
        Number(position[1]) || 0,
        Number(position[2]) || 0
    );
    vector.multiplyScalar(1 / GLTF_IMPORT_UNIT_SCALE);
    vector.applyQuaternion(EF_MATRIX_ROOT_AXIS_CORRECTION.clone().invert());
    return [
        roundNumber(vector.x, 6),
        roundNumber(vector.y, 6),
        roundNumber(vector.z, 6)
    ];
}

function convertBlockbenchNormalToEF(normal) {
    const vector = new THREE.Vector3(
        Number(normal[0]) || 0,
        Number(normal[1]) || 0,
        Number(normal[2]) || 0
    );
    vector.applyQuaternion(EF_MATRIX_ROOT_AXIS_CORRECTION.clone().invert()).normalize();
    return [
        roundNumber(vector.x, 6),
        roundNumber(vector.y, 6),
        roundNumber(vector.z, 6)
    ];
}

// ============================================================
//  Export Mesh JSON (EF format)
// ============================================================

function buildMeshExportPayload() {
    const armature = getArmature();
    const deformBones = armature ? getDeformBones(armature) : [];
    const boneNames = deformBones.map(b => b.name);
    const fallbackBoneName = boneNames.includes('Root') ? 'Root' : (boneNames[0] || 'Root');

    const elements = getAllElements();
    if (!elements.length) {
        Blockbench.showMessageBox({
            title: tl('ef.err.no_mesh'),
            icon: 'info',
            message: tl('ef.err.no_mesh_elements')
        });
        return null;
    }

    const positions = [];
    const vcounts = [];
    const weights = [];
    const vindices = [];
    const parts = {};
    const uvList = [];
    const normalList = [];
    const uvMap = {};
    const normalMap = {};

    const weightMap = {};
    let nextWeightIdx = 0;
    let nextUvIdx = 0;
    let nextNormalIdx = 0;

    function ensureWeight(w) {
        const key = w.toFixed(4);
        if (weightMap[key] === undefined) {
            weightMap[key] = nextWeightIdx;
            weights.push(w);
            nextWeightIdx++;
        }
        return weightMap[key];
    }

    function pushWeightEntry(boneName, w) {
        const bi = boneNames.indexOf(boneName);
        vindices.push(bi >= 0 ? bi : 0);
        vindices.push(ensureWeight(w));
    }

    function pushVcountsForVertices(count, vcVal) {
        for (var vi = 0; vi < count; vi++) {
            vcounts.push(vcVal);
        }
    }

    function pushTriangleToParts(partName, vi, uvIdx, normalIdx) {
        if (!parts[partName]) parts[partName] = [];
        parts[partName].push(vi);
        parts[partName].push(uvIdx);
        parts[partName].push(normalIdx);
    }

    function getOrCreateUvIdx(uv) {
        var uvKey = Math.round(uv[0] * 1e4) + ',' + Math.round(uv[1] * 1e4);
        var uvIdx = uvMap[uvKey];
        if (uvIdx === undefined) {
            uvIdx = nextUvIdx++;
            uvMap[uvKey] = uvIdx;
            uvList.push(Math.round(uv[0] * 1e6) / 1e6);
            uvList.push(Math.round(uv[1] * 1e6) / 1e6);
        }
        return uvIdx;
    }

    let vertexIdx = 0;

    for (const element of elements) {
        var currentPart = getPartNameForElement(element);
        if (element instanceof Cube) {
            var corners = getCubeCorners(element);
            var faceNames = ['north', 'south', 'east', 'west', 'up', 'down'];

            for (var fi = 0; fi < faceNames.length; fi++) {
                var faceName = faceNames[fi];
                var faceObj = element.faces[faceName];
                if (!faceObj) continue;
                var faceDef = CUBE_FACE_DEFS[faceName];
                var ci = faceDef.corners;

                var v0 = corners[ci[0]];
                var v1 = corners[ci[1]];
                var v2 = corners[ci[2]];
                var v3 = corners[ci[3]];

                var pos0 = convertBlockbenchPositionToEF(v0);
                var pos1 = convertBlockbenchPositionToEF(v1);
                var pos2 = convertBlockbenchPositionToEF(v2);
                var pos3 = convertBlockbenchPositionToEF(v3);
                positions.push(pos0[0], pos0[1], pos0[2]);
                positions.push(pos1[0], pos1[1], pos1[2]);
                positions.push(pos2[0], pos2[1], pos2[2]);
                positions.push(pos3[0], pos3[1], pos3[2]);

                var vIdx0 = vertexIdx;
                var vIdx1 = vertexIdx + 1;
                var vIdx2 = vertexIdx + 2;
                var vIdx3 = vertexIdx + 3;
                vertexIdx += 4;

                var efNormal = convertBlockbenchNormalToEF(faceDef.normal);
                var normalKey = vec3Key(efNormal).join(',');
                var normalIdx = normalMap[normalKey];
                if (normalIdx === undefined) {
                    normalIdx = nextNormalIdx++;
                    normalMap[normalKey] = normalIdx;
                    normalList.push(efNormal[0], efNormal[1], efNormal[2]);
                }

                var uvData = faceObj.uv;
                var uv0, uv1, uv2, uv3;
                if (uvData && uvData.length >= 4) {
                    var texW = (typeof Project !== 'undefined' && Project.texture_width) || 16;
                    var texH = (typeof Project !== 'undefined' && Project.texture_height) || 16;
                    // EpicFight JSON 约定: V=0 在纹理顶部, 归一化坐标
                    // Blockbench Cube face.uv = [x1, y1, x2, y2] 像素坐标, V=0 在顶部
                    // 两者方向一致, 只需归一化, 不需 V 翻转
                    var uxLeft = uvData[0] / texW;
                    var uxRight = uvData[2] / texW;
                    var vyTop = uvData[1] / texH;
                    var vyBottom = uvData[3] / texH;
                    // 顶点顺序: v0=左下, v1=右下, v2=右上, v3=左上 (对于侧面)
                    uv0 = [uxLeft, vyBottom];
                    uv1 = [uxRight, vyBottom];
                    uv2 = [uxRight, vyTop];
                    uv3 = [uxLeft, vyTop];
                } else {
                    uv0 = [0, 0];
                    uv1 = [0, 0];
                    uv2 = [0, 0];
                    uv3 = [0, 0];
                }

                var uvIdx0 = getOrCreateUvIdx(uv0);
                var uvIdx1 = getOrCreateUvIdx(uv1);
                var uvIdx2 = getOrCreateUvIdx(uv2);
                var uvIdx3 = getOrCreateUvIdx(uv3);

                pushTriangleToParts(currentPart, vIdx0, uvIdx0, normalIdx);
                pushTriangleToParts(currentPart, vIdx1, uvIdx1, normalIdx);
                pushTriangleToParts(currentPart, vIdx2, uvIdx2, normalIdx);

                pushTriangleToParts(currentPart, vIdx0, uvIdx0, normalIdx);
                pushTriangleToParts(currentPart, vIdx2, uvIdx2, normalIdx);
                pushTriangleToParts(currentPart, vIdx3, uvIdx3, normalIdx);

                var parentBone = findParentBoneForElement(element);
                var weightBoneName = parentBone ? parentBone.name : fallbackBoneName;
                pushWeightEntry(weightBoneName, 1.0);
                pushVcountsForVertices(4, 1);
            }
            continue;
        }

        const vkeys = Object.keys(element.vertices);
        const vkeyToIdx = {};
        vkeys.sort();

        for (const key of vkeys) {
            const pos = convertBlockbenchPositionToEF(element.vertices[key]);
            positions.push(pos[0], pos[1], pos[2]);

            vkeyToIdx[key] = vertexIdx;
            vertexIdx++;

            let vcVal = 0;
            const pairs = [];
            let total = 0;

            for (const bone of deformBones) {
                const w = bone.getVertexWeight(element, key);
                if (w > 1e-6) {
                    pairs.push({ name: bone.name, weight: w });
                    total += w;
                }
            }

            if (pairs.length === 0) {
                total = 1.0;
                pairs.push({ name: fallbackBoneName, weight: 1.0 });
            }

            const norm = 1.0 / total;
            for (const p of pairs) {
                const wn = Math.round(p.weight * norm * 1e4) / 1e4;
                const bi = boneNames.indexOf(p.name);
                vindices.push(bi >= 0 ? bi : 0);
                vindices.push(ensureWeight(wn));
                vcVal++;
            }
            vcounts.push(vcVal);
        }

        const faces = Object.values(element.faces || {});

        for (const face of faces) {
            let verts = getFaceVertices(face);
            if (verts.length < 3) continue;

            const tris = [];
            if (verts.length === 3) {
                tris.push(verts);
            } else if (verts.length === 4) {
                tris.push([verts[0], verts[1], verts[2]]);
                tris.push([verts[0], verts[2], verts[3]]);
            } else {
                for (let i = 1; i < verts.length - 1; i++) {
                    tris.push([verts[0], verts[i], verts[i + 1]]);
                }
            }

            for (const tri of tris) {
                const p0 = element.vertices[tri[0]];
                const p1 = element.vertices[tri[1]];
                const p2 = element.vertices[tri[2]];
                if (!p0 || !p1 || !p2) continue;
                const normal = typeof face.getNormal === 'function'
                    ? face.getNormal(true).map(v => Number(v) || 0)
                    : computeFaceNormal(p0, p1, p2);
                const efNormal = convertBlockbenchNormalToEF(normal);

                var texW = (typeof Project !== 'undefined' && Project.texture_width) || 16;
                var texH = (typeof Project !== 'undefined' && Project.texture_height) || 16;

                for (const vkey of tri) {
                    const vi = vkeyToIdx[vkey];
                    const rawUv = (face.uv && face.uv[vkey]) ? face.uv[vkey] : [0, 0];
                    // EpicFight JSON 约定: V=0 在纹理顶部, 归一化坐标
                    // Blockbench face.uv 也是像素坐标, V=0 在顶部
                    // 两者方向一致, 只需归一化, 不需 V 翻转
                    const normU = rawUv[0] / texW;
                    const normV = rawUv[1] / texH;
                    const uvKey = `${Math.round(normU*1e4)},${Math.round(normV*1e4)}`;
                    const normalKey = vec3Key(efNormal).join(',');

                    let uvIdx = uvMap[uvKey];
                    if (uvIdx === undefined) {
                        uvIdx = nextUvIdx++;
                        uvMap[uvKey] = uvIdx;
                        uvList.push(Math.round(normU * 1e6) / 1e6);
                        uvList.push(Math.round(normV * 1e6) / 1e6);
                    }

                    let normalIdx = normalMap[normalKey];
                    if (normalIdx === undefined) {
                        normalIdx = nextNormalIdx++;
                        normalMap[normalKey] = normalIdx;
                        normalList.push(efNormal[0]);
                        normalList.push(efNormal[1]);
                        normalList.push(efNormal[2]);
                    }

                    pushTriangleToParts(currentPart, vi, uvIdx, normalIdx);
                }
            }
        }
    }

    const meshData = {
        positions: createArrayDict(3, positions),
        uvs: createArrayDict(2, uvList),
        normals: createArrayDict(3, normalList)
    };

    if (vcounts.length > 0) {
        meshData.vcounts = createArrayDict(1, vcounts);
        meshData.weights = createArrayDict(1, weights);
        meshData.vindices = createArrayDict(1, vindices);
    }

    meshData.parts = {};
    for (const [name, arr] of Object.entries(parts)) {
        if (arr.length > 0) {
            meshData.parts[name] = createArrayDict(3, arr);
        }
    }

    return { vertices: meshData, fps: getExportFps() };
}

function exportMeshJson() {
    return stringifyEpicFightJson(buildMeshExportPayload());
}

// ============================================================
//  Export Armature JSON
// ============================================================

function buildArmatureExportPayloadWithFormat(exportFormat = 'attributes') {
    const armature = getArmature();
    if (!armature) {
        Blockbench.showMessageBox({
            title: tl('ef.err.no_armature'),
            icon: 'info',
            message: tl('ef.err.no_armature_project')
        });
        return null;
    }

    const boneNames = [];
    const hierarchy = [];

    function walkBone(node) {
        if (!(node instanceof ArmatureBone)) return null;
        boneNames.push(node.name);

        const entry = {
            name: node.name,
            transform: exportFormat === 'matrix'
                ? localPoseMatrixToEFMatrixArray(getBoneLocalRestMatrix(node), node)
                : decomposeBoneLocalRestMatrixToEFTransform(getBoneLocalRestMatrix(node), node),
            children: []
        };

        if (node.children) {
            for (const child of node.children) {
                const childEntry = walkBone(child);
                if (childEntry) entry.children.push(childEntry);
            }
        }
        return entry;
    }

    if (armature.children) {
        for (const child of armature.children) {
            const result = walkBone(child);
            if (result) hierarchy.push(result);
        }
    }

    const payload = {
        armature: {
            joints: boneNames,
            hierarchy: hierarchy
        },
        fps: getExportFps()
    };

    if (exportFormat !== 'matrix') {
        payload.armature_format = 'attributes';
    }

    return payload;
}

function exportArmatureJson() {
    return stringifyEpicFightJson(buildArmatureExportPayloadWithFormat('attributes'));
}

function exportModelJson(contentMode, armatureFormat) {
    const mode = contentMode || 'both';
    const format = armatureFormat === 'matrix' ? 'matrix' : 'attributes';
    if (mode === 'mesh') {
        return stringifyEpicFightJson(buildMeshExportPayload());
    }
    if (mode === 'armature') {
        return stringifyEpicFightJson(buildArmatureExportPayloadWithFormat(format));
    }

    const meshPayload = buildMeshExportPayload();
    const armaturePayload = buildArmatureExportPayloadWithFormat(format);
    if (!meshPayload || !armaturePayload) return null;

    const result = {
        vertices: meshPayload.vertices,
        armature: armaturePayload.armature,
        fps: meshPayload.fps === undefined ? armaturePayload.fps : meshPayload.fps
    };
    if (armaturePayload.armature_format) {
        result.armature_format = armaturePayload.armature_format;
    }
    return stringifyEpicFightJson(result);
}

// ============================================================
//  Export Animation JSON
// ============================================================

function optimizeAnimationKeyframes(animationData) {
    let totalRemoved = 0;
    for (const entry of animationData) {
        if (!entry || !entry.time || !entry.transform) continue;
        if (entry.time.length <= 2) continue;

        const keep = [];
        let i = 0;
        while (i < entry.time.length) {
            const runStart = i;
            while (i + 1 < entry.time.length &&
                JSON.stringify(entry.transform[i + 1]) === JSON.stringify(entry.transform[runStart])) {
                i++;
            }
            const runEnd = i;
            if (runEnd - runStart + 1 >= 3) {
                keep.push(runStart, runEnd);
            } else {
                for (let j = runStart; j <= runEnd; j++) keep.push(j);
            }
            i++;
        }

        if (keep.length < entry.time.length) {
            totalRemoved += entry.time.length - keep.length;
            entry.time = keep.map(k => entry.time[k]);
            entry.transform = keep.map(k => entry.transform[k]);
        }
    }
    return totalRemoved;
}

function buildAnimationData(anim, exportFormat, optimizeKeyframes, armature) {
    const boneNames = getAllBoneNames(armature);
    const deformBones = getDeformBones(armature);
    const dopeSheet = {};
    const timeline = new Set();

    for (const bone of deformBones) {
        const animator = anim.getBoneAnimator(bone);
        dopeSheet[bone.name] = {
            time: [],
            transform: [],
            keyedTimes: new Set()
        };
        if (!animator || !animator.keyframes || !animator.keyframes.length) continue;

        for (const kf of animator.keyframes) {
            const t = roundNumber(kf.time, 4);
            dopeSheet[bone.name].keyedTimes.add(t);
            timeline.add(t);
        }
    }

    const sortedTimeline = Array.from(timeline).sort((a, b) => a - b);
    if (!sortedTimeline.length) return null;
    const lastTime = sortedTimeline[sortedTimeline.length - 1];

    const previousTime = anim.time;
    for (const bone of deformBones) {
        const animator = anim.getBoneAnimator(bone);
        const boneSheet = dopeSheet[bone.name];
        const restLocalMatrix = getBoneLocalRestMatrix(bone);
        const restLocalInverse = restLocalMatrix.clone().invert();
        for (const time of sortedTimeline) {
            if (!(boneSheet.keyedTimes.has(time) || time === 0 || time === lastTime)) {
                continue;
            }
            let localPoseMatrix = getBoneAnimatedLocalMatrixAtTime(bone, animator, time);
            boneSheet.time.push(roundNumber(time, 4));
            boneSheet.transform.push(exportFormat === 'matrix'
                ? localPoseMatrixToEFMatrixArray(localPoseMatrix, bone)
                : decomposeAnimatedMatrixToEFAttributesTransform(localPoseMatrix, bone)
            );
        }
    }
    anim.time = previousTime;

    const output = [];
    for (const bname of boneNames) {
        const data = dopeSheet[bname];
        if (!data || !data.time.length) continue;
        output.push({
            name: bname,
            time: data.time,
            transform: data.transform
        });
    }

    if (!output.length) return null;

    if (optimizeKeyframes) {
        const removed = optimizeAnimationKeyframes(output);
        if (removed > 0) {
            console.log('[EpicFight] Optimized ' + removed + ' redundant keyframe(s) in ' + anim.name);
        }
    }

    // 追加 Coord 条目 (Coord 骨骼不存在于 armature, 导入时保存原始数据, 导出时根据目标格式转换)
    // Coord 是 root bone (无 parent), EpicFight 加载时会应用 BLENDER_TO_MINECRAFT_COORD (左乘)
    // 但 Coord 数据本身已经是 EpicFight 原始格式, 转换时不需要应用 rootAxisCorrection (仅格式转换, 不涉及坐标系)
    if (anim._ef_coord_data && anim._ef_coord_data.time && anim._ef_coord_data.time.length) {
        const coordOutput = convertCoordTransforms(anim._ef_coord_data.transform, exportFormat);
        output.push({
            name: 'Coord',
            time: anim._ef_coord_data.time.slice(),
            transform: coordOutput
        });
    }

    return output;
}

// Coord 数据格式转换: 根据目标格式 (matrix/attributes) 转换 Coord transform 数组
// 输入可能是 matrix 数组 (16 数字) 或 attributes 对象 ({loc, rot, sca})
function convertCoordTransforms(transforms, targetFormat) {
    if (!Array.isArray(transforms)) return [];
    const result = [];
    for (const t of transforms) {
        const isMatrix = Array.isArray(t);
        const isAttributes = t && typeof t === 'object' && !Array.isArray(t);
        if (targetFormat === 'matrix') {
            if (isMatrix) {
                // 原样保留
                result.push(t);
            } else if (isAttributes) {
                // attributes -> matrix
                const rotArr = Array.isArray(t.rot) ? t.rot : [1, 0, 0, 0];
                const locArr = Array.isArray(t.loc) ? t.loc : [0, 0, 0];
                const scaArr = Array.isArray(t.sca) ? t.sca : [1, 1, 1];
                const quat = new THREE.Quaternion(
                    -(Number(rotArr[1]) || 0),
                    -(Number(rotArr[2]) || 0),
                    -(Number(rotArr[3]) || 0),
                    rotArr[0] === undefined ? 1 : (Number(rotArr[0]) || 0)
                );
                const pos = new THREE.Vector3(Number(locArr[0]) || 0, Number(locArr[1]) || 0, Number(locArr[2]) || 0);
                const scale = new THREE.Vector3(
                    scaArr[0] === undefined ? 1 : Number(scaArr[0]) || 0,
                    scaArr[1] === undefined ? 1 : Number(scaArr[1]) || 0,
                    scaArr[2] === undefined ? 1 : Number(scaArr[2]) || 0
                );
                const m = new THREE.Matrix4().compose(pos, quat, scale);
                result.push(matrixToEFArray(m));
            } else {
                result.push(t);
            }
        } else {
            // targetFormat === 'attributes'
            if (isAttributes) {
                // 原样保留
                result.push(t);
            } else if (isMatrix) {
                // matrix -> attributes
                const m = parseEFMatrix(t);
                const pos = new THREE.Vector3();
                const quat = new THREE.Quaternion();
                const scale = new THREE.Vector3();
                m.decompose(pos, quat, scale);
                result.push({
                    loc: toFixedArray([pos.x, pos.y, pos.z]),
                    rot: quaternionToEFAttributesArray(quat),
                    sca: toFixedArray([scale.x, scale.y, scale.z])
                });
            } else {
                result.push(t);
            }
        }
    }
    return result;
}

function exportAnimationJson(exportFormat, optimizeKeyframes) {
    const armature = getArmature();
    if (!armature) {
        Blockbench.showMessageBox({
            title: tl('ef.err.no_armature'),
            icon: 'info',
            message: tl('ef.err.anim_needs_armature')
        });
        return null;
    }

    const anims = Animation.all;
    if (!anims || !anims.length) {
        Blockbench.showMessageBox({
            title: tl('ef.err.no_animations'),
            icon: 'info',
            message: tl('ef.err.no_animations_project')
        });
        return null;
    }

    const anim = Animation.selected || anims[0];
    const output = buildAnimationData(anim, exportFormat, optimizeKeyframes, armature);
    if (!output) {
        Blockbench.showMessageBox({
            title: tl('ef.err.no_anim_data'),
            icon: 'info',
            message: tl('ef.err.no_keyframe_data')
        });
        return null;
    }

    const result = { animation: output, fps: getExportFps() };
    if (exportFormat !== 'matrix') {
        result.format = 'attributes';
    }
    return stringifyEpicFightJson(result);
}

function exportAnimationBatchJson(exportFormat, optimizeKeyframes) {
    const armature = getArmature();
    if (!armature) {
        Blockbench.showMessageBox({
            title: tl('ef.err.no_armature'),
            icon: 'info',
            message: tl('ef.err.anim_needs_armature')
        });
        return null;
    }

    const anims = Animation.all;
    if (!anims || !anims.length) {
        Blockbench.showMessageBox({
            title: tl('ef.err.no_animations'),
            icon: 'info',
            message: tl('ef.err.no_animations_project')
        });
        return null;
    }

    const results = [];
    const skipped = [];
    const originalSelected = Animation.selected;

    for (const anim of anims) {
        Animation.selected = anim;
        const output = buildAnimationData(anim, exportFormat, optimizeKeyframes, armature);
        if (!output) {
            skipped.push(anim.name);
            continue;
        }
        const entry = { animation: output, fps: getAnimationFps(anim) };
        if (exportFormat !== 'matrix') {
            entry.format = 'attributes';
        }
        results.push({ name: anim.name, json: stringifyEpicFightJson(entry) });
    }

    Animation.selected = originalSelected;

    if (!results.length) {
        Blockbench.showMessageBox({
            title: tl('ef.err.no_anim_data'),
            icon: 'info',
            message: tl('ef.err.no_keyframe_data_batch')
        });
        return null;
    }

    return { results: results, skipped: skipped };
}

function exportEntityJson(armatureFormat, animationFormat, optimizeKeyframes) {
    const armature = getArmature();
    if (!armature) {
        Blockbench.showMessageBox({
            title: tl('ef.err.no_armature'),
            icon: 'info',
            message: tl('ef.err.entity_needs_armature')
        });
        return null;
    }

    const meshPayload = buildMeshExportPayload();
    const armaturePayload = buildArmatureExportPayloadWithFormat(armatureFormat);
    if (!meshPayload || !armaturePayload) return null;

    const result = {
        vertices: meshPayload.vertices,
        armature: armaturePayload.armature,
        fps: meshPayload.fps === undefined ? armaturePayload.fps : meshPayload.fps
    };
    if (armaturePayload.armature_format) {
        result.armature_format = armaturePayload.armature_format;
    }

    const anims = Animation.all;
    if (anims && anims.length) {
        const animOutput = [];
        const originalSelected = Animation.selected;
        for (const anim of anims) {
            Animation.selected = anim;
            const data = buildAnimationData(anim, animationFormat, optimizeKeyframes, armature);
            if (data) animOutput.push(data);
        }
        Animation.selected = originalSelected;
        if (animOutput.length) {
            result.animation = animOutput;
            if (animationFormat !== 'matrix') {
                result.format = 'attributes';
            }
        }
    }

    return stringifyEpicFightJson(result);
}



function doExport(name, exportFn) {
    try {
        const json = exportFn();
        if (!json) return;
        Filesystem.exportFile({
            type: 'EpicFight JSON',
            extensions: ['json'],
            name: name,
            content: json,
            resource_id: 'epicfight_export'
        }, function(path) {
            Blockbench.showToastNotification({
                text: tl('ef.msg.exported') + ': ' + path,
                color: 'green',
                icon: 'check'
            });
        });
    } catch (e) {
        Blockbench.showMessageBox({
            title: tl('ef.err.export'),
            icon: 'error',
            message: e.message || String(e)
        });
    }
}

function exportAnimationWithFormatChoice() {
    new Dialog({
        id: 'ef_export_animation_format',
        title: tl('ef.dlg.export_anim_format'),
        form: {
            format: {
                type: 'select',
                label: tl('ef.label.format'),
                value: 'attributes',
                options: {
                    attributes: 'attributes',
                    matrix: 'matrix'
                }
            },
            optimize: {
                type: 'checkbox',
                label: tl('ef.label.optimize'),
                value: true
            }
        },
        onConfirm(result) {
            const format = result && result.format === 'matrix' ? 'matrix' : 'attributes';
            const optimize = !!(result && result.optimize);
            const fileName = format === 'matrix' ? 'animation_matrix.json' : 'animation_attributes.json';
            doExport(fileName, function() {
                return exportAnimationJson(format, optimize);
            });
        }
    }).show();
}

function exportModelWithContentChoice() {
    new Dialog({
        id: 'ef_export_model_content',
        title: tl('ef.dlg.export_model'),
        form: {
            content: {
                type: 'select',
                label: tl('ef.label.content'),
                value: 'both',
                options: {
                    both: tl('ef.opt.both'),
                    mesh: tl('ef.opt.mesh_only'),
                    armature: tl('ef.opt.armature_only')
                }
            },
            armature_format: {
                type: 'select',
                label: tl('ef.label.armature_format'),
                value: 'attributes',
                options: {
                    attributes: 'attributes',
                    matrix: 'matrix'
                }
            },
            note: {
                type: 'info',
                text: tl('ef.note.mesh_only_ignores')
            }
        },
        onConfirm(result) {
            const mode = result && typeof result.content === 'string' ? result.content : 'both';
            const format = result && result.armature_format === 'matrix' ? 'matrix' : 'attributes';
            const fileName = mode === 'mesh'
                ? 'mesh.json'
                : (mode === 'armature'
                    ? (format === 'matrix' ? 'armature_matrix.json' : 'armature_attributes.json')
                    : (format === 'matrix' ? 'model_matrix.json' : 'model_attributes.json'));
            doExport(fileName, function() {
                return exportModelJson(mode, format);
            });
        }
    }).show();
}

function exportAnimationBatchWithChoice() {
    new Dialog({
        id: 'ef_export_animation_batch',
        title: tl('ef.dlg.batch_export'),
        form: {
            format: {
                type: 'select',
                label: tl('ef.label.format'),
                value: 'attributes',
                options: {
                    attributes: 'attributes',
                    matrix: 'matrix'
                }
            },
            optimize: {
                type: 'checkbox',
                label: tl('ef.label.optimize'),
                value: true
            }
        },
        onConfirm(result) {
            const format = result && result.format === 'matrix' ? 'matrix' : 'attributes';
            const optimize = !!(result && result.optimize);
            try {
                const batchResult = exportAnimationBatchJson(format, optimize);
                if (!batchResult) return;
                let exported = 0;
                const errors = [];
                for (const item of batchResult.results) {
                    const safeName = String(item.name).replace(/[<>:"/\\|?*]/g, '_');
                    const suffix = format === 'matrix' ? '_matrix' : '_attributes';
                    const fileName = safeName + suffix + '.json';
                    try {
                        Filesystem.exportFile({
                            type: 'EpicFight JSON',
                            extensions: ['json'],
                            name: fileName,
                            content: item.json,
                            resource_id: 'epicfight_export'
                        }, function(path) {
                            exported++;
                        });
                    } catch (e) {
                        errors.push(item.name + ': ' + (e.message || String(e)));
                    }
                }
                Blockbench.showToastNotification({
                    text: batchResult.results.length + ' ' + tl('ef.msg.batch_exported') + '.' +
                        (batchResult.skipped.length ? ' ' + batchResult.skipped.length + ' ' + tl('ef.msg.skipped') + '.' : '') +
                        (errors.length ? ' ' + errors.length + ' ' + tl('ef.msg.error_count') + '.' : ''),
                    color: errors.length || batchResult.skipped.length ? 'orange' : 'green',
                    icon: errors.length ? 'warning' : 'check'
                });
                if (batchResult.skipped.length || errors.length) {
                    const lines = [];
                    if (batchResult.skipped.length) {
                        lines.push(tl('ef.msg.skipped_no_data') + ': ' + batchResult.skipped.join(', '));
                    }
                    errors.forEach(function(err) { lines.push(err); });
                    Blockbench.showMessageBox({
                        title: tl('ef.summary.batch_export'),
                        icon: 'warning',
                        message: lines.join('\n')
                    });
                }
            } catch (e) {
                Blockbench.showMessageBox({
                    title: tl('ef.err.export'),
                    icon: 'error',
                    message: e.message || String(e)
                });
            }
        }
    }).show();
}

function exportEntityWithChoice() {
    new Dialog({
        id: 'ef_export_entity',
        title: tl('ef.dlg.export_entity'),
        form: {
            armature_format: {
                type: 'select',
                label: tl('ef.label.armature_format'),
                value: 'attributes',
                options: {
                    attributes: 'attributes',
                    matrix: 'matrix'
                }
            },
            animation_format: {
                type: 'select',
                label: tl('ef.label.animation_format'),
                value: 'attributes',
                options: {
                    attributes: 'attributes',
                    matrix: 'matrix'
                }
            },
            optimize: {
                type: 'checkbox',
                label: tl('ef.label.optimize'),
                value: true
            }
        },
        onConfirm(result) {
            const armFmt = result && result.armature_format === 'matrix' ? 'matrix' : 'attributes';
            const animFmt = result && result.animation_format === 'matrix' ? 'matrix' : 'attributes';
            const optimize = !!(result && result.optimize);
            doExport('entity.json', function() {
                return exportEntityJson(armFmt, animFmt, optimize);
            });
        }
    }).show();
}

// ============================================================
//  i18n - Internationalization
// ============================================================

const EF_I18N = {
    en: {
        // Actions
        'ef.import_mesh': 'Import EpicFight Mesh JSON',
        'ef.import_mesh.desc': 'Import official EpicFight mesh JSON with armature and vertex weights',
        'ef.import_armature': 'Import EpicFight Armature JSON',
        'ef.import_armature.desc': 'Import EpicFight armature JSON into Blockbench',
        'ef.import_animation': 'Import EpicFight Animation JSON',
        'ef.import_animation.desc': 'Import EpicFight animation JSON into the current Blockbench armature',
        'ef.export_model': 'Export as EpicFight Model JSON',
        'ef.export_model.desc': 'Export mesh, armature, or both to EpicFight JSON format',
        'ef.export_animation': 'Export as EpicFight Animation JSON',
        'ef.export_animation.desc': 'Export animation as EpicFight matrix or attributes JSON',
        'ef.export_animation_batch': 'Batch Export EpicFight Animations',
        'ef.export_animation_batch.desc': 'Export all animations as separate EpicFight JSON files',
        'ef.export_entity': 'Export as EpicFight Entity JSON',
        'ef.export_entity.desc': 'Export mesh, armature, and all animations into a single JSON file',
        // File dialog titles
        'ef.select_mesh': 'Select EpicFight mesh JSON',
        'ef.select_armature': 'Select EpicFight armature JSON',
        'ef.select_animation': 'Select EpicFight animation JSON',
        // Dialog titles
        'ef.dlg.export_anim_format': 'Export Animation Format',
        'ef.dlg.export_model': 'Export Model Options',
        'ef.dlg.batch_export': 'Batch Export Animations',
        'ef.dlg.export_entity': 'Export EpicFight Entity',
        // Form labels
        'ef.label.format': 'Format',
        'ef.label.content': 'Content',
        'ef.label.armature_format': 'Armature Format',
        'ef.label.animation_format': 'Animation Format',
        'ef.label.optimize': 'Optimize keyframes',
        // Options
        'ef.opt.both': 'Mesh + Armature',
        'ef.opt.mesh_only': 'Mesh Only',
        'ef.opt.armature_only': 'Armature Only',
        'ef.note.mesh_only_ignores': 'Mesh Only ignores Armature Format.',
        // Toast / messages
        'ef.msg.importing_anim': 'Importing EpicFight animation',
        'ef.msg.mesh_imported': 'Mesh imported',
        'ef.msg.armature_imported': 'Armature imported',
        'ef.msg.anim_imported': 'animation(s) imported',
        'ef.msg.keyframes': 'keyframes',
        'ef.msg.exported': 'Exported',
        'ef.msg.batch_exported': 'animation(s) exported',
        'ef.msg.skipped': 'skipped',
        'ef.msg.error_count': 'error(s)',
        'ef.msg.files': 'files',
        'ef.msg.file_failed': 'file(s) failed',
        'ef.msg.have_missing_bones': 'file(s) have missing bones',
        // Error titles
        'ef.err.mesh_import': 'Mesh Import Error',
        'ef.err.armature_import': 'Armature Import Error',
        'ef.err.anim_import': 'Animation Import Error',
        'ef.err.export': 'Export Error',
        'ef.err.no_mesh': 'No Mesh',
        'ef.err.no_armature': 'No Armature',
        'ef.err.no_animations': 'No Animations',
        'ef.err.no_anim_data': 'No Animation Data',
        // Error messages
        'ef.err.parse_mesh': 'Failed to parse mesh JSON',
        'ef.err.parse_armature': 'Failed to parse armature JSON',
        'ef.err.no_mesh_elements': 'No mesh elements or cubes found in the project.',
        'ef.err.no_armature_project': 'No armature found in the project.',
        'ef.err.anim_needs_armature': 'Animation export requires an armature.',
        'ef.err.entity_needs_armature': 'Entity export requires an armature.',
        'ef.err.no_animations_project': 'No animations found in the project.',
        'ef.err.no_keyframe_data': 'No keyframe data found for any bone.',
        'ef.err.no_keyframe_data_batch': 'No keyframe data found for any animation.',
        'ef.err.no_anim_files': 'No animation files were imported.',
        // Summary
        'ef.summary.anim_import': 'Animation Import Summary',
        'ef.summary.batch_export': 'Batch Export Summary',
        'ef.msg.missing_bones': 'Missing bones',
        'ef.msg.coord_ignored': 'Coord ignored.',
        'ef.msg.coord_preview_mode': 'Coord files are still imported in preview mode.',
        'ef.msg.skipped_no_data': 'Skipped (no data)',
        // IK
        'ef.ik.create_controller': 'Create IK Controller',
        'ef.ik.break_controller': 'Break IK Controller',
        'ef.ik.bake': 'Bake IK',
        'ef.ik.select_source': 'Select IK Source',
        'ef.ik.controller_created': 'IK controller created',
        'ef.ik.no_controller': 'No IK controller found',
        'ef.ik.no_bones': 'No ArmatureBone selected',
        'ef.ik.toggle': 'Toggle IK Controller',
        'ef.ik.enabled': 'IK enabled',
        'ef.ik.disabled': 'IK disabled',
        'ef.ik.limits': 'IK Angle Limits',
        'ef.ik.limits_title': 'IK Angle Limits',
        'ef.ik.enabled_suffix': 'Enabled',
        'ef.ik.limitation_axis': 'Limitation Axis',
        'ef.ik.min_deg': 'Min (deg)',
        'ef.ik.max_deg': 'Max (deg)',
        'ef.ik.none': 'None',
        'ef.ik.edit_limits_undo': 'Edit IK angle limits',
        'ef.ik.create_undo': 'Create IK controller',
        'ef.ik.change_source_undo': 'Change IK source',
        'ef.ik.break_undo': 'Break IK controller',
        'ef.ik.enable_undo': 'Enable IK controller',
        'ef.ik.disable_undo': 'Disable IK controller'
    },
    zh: {
        // Actions
        'ef.import_mesh': '导入 EpicFight 模型 JSON',
        'ef.import_mesh.desc': '导入 EpicFight 官方模型 JSON（含骨架和顶点权重）',
        'ef.import_armature': '导入 EpicFight 骨架 JSON',
        'ef.import_armature.desc': '导入 EpicFight 独立骨架 JSON 到 Blockbench',
        'ef.import_animation': '导入 EpicFight 动画 JSON',
        'ef.import_animation.desc': '导入 EpicFight 动画 JSON 到当前 Blockbench 骨架',
        'ef.export_model': '导出 EpicFight 模型 JSON',
        'ef.export_model.desc': '导出模型、骨架或两者到 EpicFight JSON 格式',
        'ef.export_animation': '导出 EpicFight 动画 JSON',
        'ef.export_animation.desc': '导出动画为 EpicFight matrix 或 attributes JSON',
        'ef.export_animation_batch': '批量导出 EpicFight 动画',
        'ef.export_animation_batch.desc': '将所有动画分别导出为独立 EpicFight JSON 文件',
        'ef.export_entity': '导出 EpicFight 实体 JSON',
        'ef.export_entity.desc': '将模型、骨架和所有动画打包导出为单个 JSON 文件',
        // File dialog titles
        'ef.select_mesh': '选择 EpicFight 模型 JSON',
        'ef.select_armature': '选择 EpicFight 骨架 JSON',
        'ef.select_animation': '选择 EpicFight 动画 JSON',
        // Dialog titles
        'ef.dlg.export_anim_format': '导出动画格式',
        'ef.dlg.export_model': '导出模型选项',
        'ef.dlg.batch_export': '批量导出动画',
        'ef.dlg.export_entity': '导出 EpicFight 实体',
        // Form labels
        'ef.label.format': '格式',
        'ef.label.content': '内容',
        'ef.label.armature_format': '骨架格式',
        'ef.label.animation_format': '动画格式',
        'ef.label.optimize': '优化关键帧',
        // Options
        'ef.opt.both': '模型 + 骨架',
        'ef.opt.mesh_only': '仅模型',
        'ef.opt.armature_only': '仅骨架',
        'ef.note.mesh_only_ignores': '仅模型时忽略骨架格式。',
        // Toast / messages
        'ef.msg.importing_anim': '正在导入 EpicFight 动画',
        'ef.msg.mesh_imported': '模型已导入',
        'ef.msg.armature_imported': '骨架已导入',
        'ef.msg.anim_imported': '个动画已导入',
        'ef.msg.keyframes': '个关键帧',
        'ef.msg.exported': '已导出',
        'ef.msg.batch_exported': '个动画已导出',
        'ef.msg.skipped': '已跳过',
        'ef.msg.error_count': '个错误',
        'ef.msg.files': '个文件',
        'ef.msg.file_failed': '个文件失败',
        'ef.msg.have_missing_bones': '个文件缺少骨骼',
        // Error titles
        'ef.err.mesh_import': '模型导入错误',
        'ef.err.armature_import': '骨架导入错误',
        'ef.err.anim_import': '动画导入错误',
        'ef.err.export': '导出错误',
        'ef.err.no_mesh': '无模型',
        'ef.err.no_armature': '无骨架',
        'ef.err.no_animations': '无动画',
        'ef.err.no_anim_data': '无动画数据',
        // Error messages
        'ef.err.parse_mesh': '解析模型 JSON 失败',
        'ef.err.parse_armature': '解析骨架 JSON 失败',
        'ef.err.no_mesh_elements': '项目中未找到模型元素或方块。',
        'ef.err.no_armature_project': '项目中未找到骨架。',
        'ef.err.anim_needs_armature': '动画导出需要骨架。',
        'ef.err.entity_needs_armature': '实体导出需要骨架。',
        'ef.err.no_animations_project': '项目中未找到动画。',
        'ef.err.no_keyframe_data': '未找到任何骨骼的关键帧数据。',
        'ef.err.no_keyframe_data_batch': '未找到任何动画的关键帧数据。',
        'ef.err.no_anim_files': '未导入任何动画文件。',
        // Summary
        'ef.summary.anim_import': '动画导入摘要',
        'ef.summary.batch_export': '批量导出摘要',
        'ef.msg.missing_bones': '缺失骨骼',
        'ef.msg.coord_ignored': 'Coord 已忽略。',
        'ef.msg.coord_preview_mode': 'Coord 文件仍以预览模式导入。',
        'ef.msg.skipped_no_data': '已跳过（无数据）',
        // IK
        'ef.ik.create_controller': '创建 IK 控制器',
        'ef.ik.break_controller': '断开 IK 控制器',
        'ef.ik.bake': '烘焙 IK',
        'ef.ik.select_source': '选择 IK 源',
        'ef.ik.controller_created': 'IK 控制器已创建',
        'ef.ik.no_controller': '未找到 IK 控制器',
        'ef.ik.no_bones': '未选中 ArmatureBone',
        'ef.ik.toggle': '切换 IK 控制器',
        'ef.ik.enabled': 'IK 已启用',
        'ef.ik.disabled': 'IK 已禁用',
        'ef.ik.limits': 'IK 角度限制',
        'ef.ik.limits_title': 'IK 角度限制',
        'ef.ik.enabled_suffix': '启用',
        'ef.ik.limitation_axis': '限制轴',
        'ef.ik.min_deg': '最小 (度)',
        'ef.ik.max_deg': '最大 (度)',
        'ef.ik.none': '无',
        'ef.ik.edit_limits_undo': '编辑 IK 角度限制',
        'ef.ik.create_undo': '创建 IK 控制器',
        'ef.ik.change_source_undo': '更改 IK 源',
        'ef.ik.break_undo': '断开 IK 控制器',
        'ef.ik.enable_undo': '启用 IK 控制器',
        'ef.ik.disable_undo': '禁用 IK 控制器'
    }
};

function efRegisterTranslations() {
    if (typeof Language === 'undefined' || typeof Language.addTranslations !== 'function') return;
    for (var lang in EF_I18N) {
        Language.addTranslations(lang, EF_I18N[lang]);
    }
}

// ============================================================
//  IK Support for ArmatureBone
//  复用 Blockbench 原生 NullObject 作为 IK 控制器/目标
//  自定义 displayIK 求解，修复 Blockbench 原生求解对旋转骨骼的处理问题
//  流程: 选择末端骨骼 -> 右键 创建 IK 控制器 -> 选择 source -> 拖动 NullObject
// ============================================================

function efSetupIKSupport() {
    if (typeof ArmatureBone === 'undefined' || !ArmatureBone.animator) return null;
    try {
        return efSetupIKSupportInner();
    } catch (e) {
        console.error('[EF] IK setup failed:', e);
        return null;
    }
}

function efSetupIKSupportInner() {
    // Three.js CCDIKSolver 内联实现（简化版，移除可视化 helper）
    const _quaternion = new THREE.Quaternion();
    const _targetPos = new THREE.Vector3();
    const _targetVec = new THREE.Vector3();
    const _effectorPos = new THREE.Vector3();
    const _effectorVec = new THREE.Vector3();
    const _linkPos = new THREE.Vector3();
    const _invLinkQ = new THREE.Quaternion();
    const _linkScale = new THREE.Vector3();
    const _axis = new THREE.Vector3();
    const _vector = new THREE.Vector3();

    class CCDIKSolver {
        constructor(mesh, iks = []) {
            this.mesh = mesh;
            this.iks = iks;
            this._initialQuaternions = [];
            this._workingQuaternion = new THREE.Quaternion();
            for (const ik of iks) {
                const chainQuats = [];
                for (let i = 0; i < ik.links.length; i++) {
                    chainQuats.push(new THREE.Quaternion());
                }
                this._initialQuaternions.push(chainQuats);
            }
            this._valid();
        }
        update(globalBlendFactor = 1.0) {
            const iks = this.iks;
            for (let i = 0, il = iks.length; i < il; i++) {
                this.updateOne(iks[i], globalBlendFactor);
            }
            return this;
        }
        updateOne(ik, overrideBlend = 1.0) {
            const chainBlend = ik.blendFactor !== undefined ? ik.blendFactor : overrideBlend;
            const bones = this.mesh.skeleton.bones;
            const chainIndex = this.iks.indexOf(ik);
            const initialQuaternions = this._initialQuaternions[chainIndex];
            const math = Math;
            const effector = bones[ik.effector];
            const target = bones[ik.target];
            _targetPos.setFromMatrixPosition(target.matrixWorld);
            const links = ik.links;
            const iteration = ik.iteration !== undefined ? ik.iteration : 1;
            if (chainBlend < 1.0) {
                for (let j = 0; j < links.length; j++) {
                    const linkIndex = links[j].index;
                    initialQuaternions[j].copy(bones[linkIndex].quaternion);
                }
            }
            for (let i = 0; i < iteration; i++) {
                let rotated = false;
                for (let j = 0, jl = links.length; j < jl; j++) {
                    const link = bones[links[j].index];
                    if (links[j].enabled === false) break;
                    const limitation = links[j].limitation;
                    const rotationMin = links[j].rotationMin;
                    const rotationMax = links[j].rotationMax;
                    link.matrixWorld.decompose(_linkPos, _invLinkQ, _linkScale);
                    _invLinkQ.invert();
                    _effectorPos.setFromMatrixPosition(effector.matrixWorld);
                    _effectorVec.subVectors(_effectorPos, _linkPos);
                    _effectorVec.applyQuaternion(_invLinkQ);
                    _effectorVec.normalize();
                    _targetVec.subVectors(_targetPos, _linkPos);
                    _targetVec.applyQuaternion(_invLinkQ);
                    _targetVec.normalize();
                    let angle = _targetVec.dot(_effectorVec);
                    if (angle > 1.0) angle = 1.0;
                    else if (angle < -1.0) angle = -1.0;
                    angle = math.acos(angle);
                    if (angle < 1e-5) continue;
                    if (ik.minAngle !== undefined && angle < ik.minAngle) angle = ik.minAngle;
                    if (ik.maxAngle !== undefined && angle > ik.maxAngle) angle = ik.maxAngle;
                    _axis.crossVectors(_effectorVec, _targetVec);
                    _axis.normalize();
                    _quaternion.setFromAxisAngle(_axis, angle);
                    link.quaternion.multiply(_quaternion);
                    if (limitation !== undefined) {
                        let c = link.quaternion.w;
                        if (c > 1.0) c = 1.0;
                        const dot = link.quaternion.x * limitation.x + link.quaternion.y * limitation.y + link.quaternion.z * limitation.z;
                        const sign = dot < 0 ? -1 : 1;
                        const c2 = sign * math.sqrt(1 - c * c);
                        link.quaternion.set(
                            limitation.x * c2,
                            limitation.y * c2,
                            limitation.z * c2,
                            c
                        );
                    }
                    if (rotationMin !== undefined || rotationMax !== undefined) {
                        const euler = _vector.setFromEuler(link.rotation);
                        if (rotationMin !== undefined) euler.max(rotationMin);
                        if (rotationMax !== undefined) euler.min(rotationMax);
                        link.rotation.setFromVector3(euler);
                    }
                    link.updateMatrixWorld(true);
                    rotated = true;
                }
                if (!rotated) break;
            }
            if (chainBlend < 1.0) {
                for (let j = 0; j < links.length; j++) {
                    const linkIndex = links[j].index;
                    const link = bones[linkIndex];
                    this._workingQuaternion.copy(initialQuaternions[j]).slerp(link.quaternion, chainBlend);
                    link.quaternion.copy(this._workingQuaternion);
                    link.updateMatrixWorld(true);
                }
            }
            return this;
        }
        _valid() {
            const iks = this.iks;
            const bones = this.mesh.skeleton.bones;
            for (let i = 0; i < iks.length; i++) {
                const ik = iks[i];
                const effector = bones[ik.effector];
                const links = ik.links;
                let link0 = effector;
                for (let j = 0; j < links.length; j++) {
                    const link1 = bones[links[j].index];
                    if (link0.parent !== link1) {
                        console.warn('CCDIKSolver: bone ' + link0.name + ' is not the child of bone ' + link1.name);
                    }
                    link0 = link1;
                }
            }
        }
    }

    if (typeof NullObject === 'undefined') {
        console.warn('[EF] NullObject not available, IK support disabled');
        return null;
    }

    const scene = (typeof Canvas !== 'undefined' && Canvas.scene) ? Canvas.scene : ((typeof Project !== 'undefined' && Project.model_3d) ? Project.model_3d : null);

    function efFindNodeByUuid(uuid) {
        if (!uuid) return null;
        return [...Group.all, ...ArmatureBone.all, ...Locator.all, ...NullObject.all].find(node => node.uuid === uuid);
    }

    // 查找 IK source 下作为 pole target 参考的 helper bone（knee/elbow），排除目标骨骼自身
    function efFindPoleHelperBone(sourceBone, targetBone) {
        if (!(sourceBone instanceof ArmatureBone)) return null;
        return sourceBone.children.find(child =>
            child instanceof ArmatureBone &&
            child !== targetBone &&
            /^(knee|elbow)_/i.test(child.name)
        ) || null;
    }

    // 估算骨骼尾端（ankle/wrist）的世界位置
    // 先求 mesh 的本地包围盒，再取本地 Y 方向绝对值最大的端点，避免 world box 对角点不准
    function efGetBoneTailWorldPosition(bone) {
        if (!bone || !bone.mesh) {
            return bone.getWorldCenter ? bone.getWorldCenter() : new THREE.Vector3();
        }
        const worldBox = new THREE.Box3().setFromObject(bone.mesh);
        const size = worldBox.getSize(new THREE.Vector3());
        if (size.lengthSq() < 1e-6) {
            return bone.getWorldCenter ? bone.getWorldCenter() : new THREE.Vector3();
        }
        const invMatrix = bone.mesh.matrixWorld.clone().invert();
        const localBox = new THREE.Box3();
        for (const x of [worldBox.min.x, worldBox.max.x]) {
            for (const y of [worldBox.min.y, worldBox.max.y]) {
                for (const z of [worldBox.min.z, worldBox.max.z]) {
                    localBox.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(invMatrix));
                }
            }
        }
        const tipY = Math.abs(localBox.max.y) > Math.abs(localBox.min.y) ? localBox.max.y : localBox.min.y;
        const tailLocal = new THREE.Vector3(0, tipY, 0);
        return tailLocal.applyMatrix4(bone.mesh.matrixWorld);
    }

    // 计算 pole target 的默认世界位置：复用 EpicFight helper bone 的方向
    // helper bone（Knee_R/L、Elbow_R/L）的本地 Y 轴就是原 rig 里 pole target 的方向
    function efComputePoleWorldPosition(sourceBone, targetBone, helperBone) {
        const hipWorld = sourceBone.mesh.getWorldPosition(new THREE.Vector3());
        const kneeWorld = helperBone ? helperBone.mesh.getWorldPosition(new THREE.Vector3()) : targetBone.mesh.getWorldPosition(new THREE.Vector3());
        const ankleWorld = targetBone.getWorldCenter();
        const thighLen = hipWorld.distanceTo(kneeWorld);

        let poleDir;
        if (helperBone && helperBone.mesh) {
            const worldQuat = helperBone.mesh.getWorldQuaternion(new THREE.Quaternion());
            poleDir = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuat).normalize();
            if (poleDir.lengthSq() < 1e-6) poleDir = null;
        }

        if (!poleDir) {
            const chainDir = ankleWorld.clone().sub(hipWorld).normalize();
            const up = new THREE.Vector3(0, 1, 0);
            poleDir = new THREE.Vector3().crossVectors(chainDir, up);
            if (poleDir.lengthSq() < 1e-6) poleDir = new THREE.Vector3(1, 0, 0);
            poleDir.normalize();
            const outwardSign = hipWorld.x < 0 ? -1 : 1;
            if (poleDir.x * outwardSign < 0) poleDir.negate();
        }

        const offsetDistance = thighLen * 0.75;
        return kneeWorld.clone().add(poleDir.multiplyScalar(offsetDistance));
    }

    // 查找与骨骼关联的 NullObject IK 控制器
    function efFindController(targetBone) {
        return NullObject.all.find(no => no.ik_target === targetBone.uuid);
    }

    // 选择不在 IK 链中的 Armature/Group/root 作为控制器父级
    function efGetControllerParent(sourceBone) {
        let parent = sourceBone.parent;
        while (parent !== 'root') {
            if (parent instanceof Group || parent instanceof Armature) return parent;
            parent = parent.parent;
            if (!parent) return 'root';
        }
        return 'root';
    }

    // 收集可作为 IK source 的骨骼（选中骨骼的祖先）
    function efCollectSourceCandidates(targetBone) {
        const nodes = [];
        function collect(arr) {
            arr.forEach(node => {
                if (node instanceof ArmatureBone && targetBone.isChildOf(node)) nodes.push(node);
                if (node.children) collect(node.children);
            });
        }
        collect(Outliner.root);
        return nodes;
    }

    // 创建 NullObject 作为 IK 控制器
    // 根据骨骼名称推断默认 IK 角度限制
    // Blockbench ArmatureBone 的本地 Y 轴为骨骼长度方向，膝盖/肘部弯曲通常绕 X 轴
    function efGetDefaultIKLimit(bone) {
        const name = bone.name.toLowerCase();
        // 小腿/前臂/手部末端骨骼：铰链关节，限制弯曲轴
        // EpicFight biped 中 Hand_R/Hand_L 实际为前臂，Foot 类骨骼同理
        if (/leg|shin|calf|forearm|arm_lower|lower_arm|hand/.test(name)) {
            return {
                enabled: true,
                limitation: new THREE.Vector3(1, 0, 0),
                rotationMin: new THREE.Vector3(-Math.PI / 2, 0, 0),
                rotationMax: new THREE.Vector3(0, 0, 0)
            };
        }
        // 大腿/上臂：球关节，限制外展/内收
        if (/thigh|upper_arm|arm_upper/.test(name)) {
            return {
                enabled: true,
                rotationMin: new THREE.Vector3(-Math.PI / 4, -Math.PI / 2, -Math.PI / 4),
                rotationMax: new THREE.Vector3(Math.PI / 4, Math.PI / 2, Math.PI / 4)
            };
        }
        return null;
    }

    function efCreateController(targetBone, sourceBone) {
        if (!targetBone.isChildOf(sourceBone)) return null;

        const created = [];
        Undo.initEdit({elements: created, outliner: true});

        const parent = efGetControllerParent(sourceBone);
        const controller = new NullObject().addTo(parent).init();
        controller.name = targetBone.name + '_ik';
        controller.ik_target = targetBone.uuid;
        controller.ik_source = sourceBone.uuid;

        // 收集 IK 链上的骨骼并设置默认角度限制
        controller.ik_limits = {};
        const chainBones = [];
        let cur = targetBone;
        while (cur !== sourceBone) {
            if (cur instanceof ArmatureBone) chainBones.push(cur);
            cur = cur.parent;
        }
        if (sourceBone instanceof ArmatureBone) chainBones.push(sourceBone);
        chainBones.reverse();
        chainBones.forEach(bone => {
            const limit = efGetDefaultIKLimit(bone);
            if (limit) controller.ik_limits[bone.uuid] = limit;
        });

        // 控制器放在目标骨骼尾端（ankle/wrist），而不是骨骼中心
        const targetWorld = efGetBoneTailWorldPosition(targetBone);
        let localPos = targetWorld.clone();
        if (parent !== 'root') {
            parent.mesh.worldToLocal(localPos);
        }
        controller.position[0] = localPos.x;
        controller.position[1] = localPos.y;
        controller.position[2] = localPos.z;
        controller.preview_controller.updateTransform(controller);

        // 创建 pole target，默认位置放在 knee/elbow 关节的偏移方向，避免与控制器重叠
        const pole = new NullObject().addTo(parent).init();
        pole.name = targetBone.name + '_ik_pole';
        controller.ik_pole = pole.uuid;
        pole.ik_controller = controller.uuid;

        const helperBone = efFindPoleHelperBone(sourceBone, targetBone);
        const poleWorld = efComputePoleWorldPosition(sourceBone, targetBone, helperBone);
        let poleLocal = poleWorld.clone();
        if (parent !== 'root') {
            parent.mesh.worldToLocal(poleLocal);
        }
        pole.position[0] = poleLocal.x;
        pole.position[1] = poleLocal.y;
        pole.position[2] = poleLocal.z;
        pole.preview_controller.updateTransform(pole);

        created.push(controller, pole);
        Undo.finishEdit(tl('ef.ik.create_undo'));
        Blockbench.showQuickMessage(tl('ef.ik.controller_created'));
        return controller;
    }

    // pole 作为 Thigh FK 控制器：pole 决定大腿方向，小腿再伸向脚踝
    function efSolveFKPoleIK(bones, target, controller, pole, boneWorldPositions, get_samples) {
        if (bones.length !== 2) return null;

        const hipWorld = boneWorldPositions[0].start.clone();
        const kneeRest = boneWorldPositions[0].end.clone();
        const ankleTarget = controller.getWorldCenter(true);
        const poleWorld = pole.getWorldCenter(true);
        const thighLen = hipWorld.distanceTo(kneeRest);

        const hipToPole = poleWorld.clone().sub(hipWorld);
        const poleDir = hipToPole.lengthSq() > 1e-6 ? hipToPole.normalize() : new THREE.Vector3(0, -1, 0);
        const kneeWorld = hipWorld.clone().add(poleDir.multiplyScalar(thighLen));

        // 小腿保持原长，只把末端指向 ankle 控制器方向，避免拉伸
        const kneeToAnkle = ankleTarget.clone().sub(kneeWorld);
        const legDir = kneeToAnkle.lengthSq() > 1e-6 ? kneeToAnkle.normalize() : poleDir.clone();
        const legLen = boneWorldPositions[1].end.distanceTo(boneWorldPositions[1].start);
        const ankleClamped = kneeWorld.clone().add(legDir.multiplyScalar(legLen));

        const fikBones = [
            { start: hipWorld, end: kneeWorld },
            { start: kneeWorld, end: ankleClamped }
        ];

        const results = {};
        bones.forEach((bone, i) => {
            const restWorld = boneWorldPositions[i].end.clone().sub(boneWorldPositions[i].start).normalize();
            const ikWorld = fikBones[i].end.clone().sub(fikBones[i].start).normalize();

            const deltaQuat = new THREE.Quaternion().setFromUnitVectors(restWorld, ikWorld);
            const parentQuat = bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion());
            const localDeltaQuat = parentQuat.clone().invert().multiply(deltaQuat).multiply(parentQuat);
            const fixQuat = new THREE.Quaternion().setFromEuler(
                bone.mesh.fix_rotation || new THREE.Euler(0, 0, 0),
                Format.euler_order || 'ZYX'
            );
            const newLocalQuat = localDeltaQuat.multiply(fixQuat);
            const newEuler = new THREE.Euler().setFromQuaternion(newLocalQuat, Format.euler_order || 'ZYX');

            // 应用 IK 角度限制（限制值表示相对于 rest pose 的偏移）
            const limit = controller.ik_limits && controller.ik_limits[bone.uuid];
            if (limit && limit.enabled) {
                const fixRot = bone.mesh.fix_rotation || new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
                const offsetEuler = new THREE.Euler(
                    newEuler.x - fixRot.x,
                    newEuler.y - fixRot.y,
                    newEuler.z - fixRot.z,
                    Format.euler_order || 'ZYX'
                );
                if (limit.rotationMin) {
                    offsetEuler.x = Math.max(offsetEuler.x, limit.rotationMin.x);
                    offsetEuler.y = Math.max(offsetEuler.y, limit.rotationMin.y);
                    offsetEuler.z = Math.max(offsetEuler.z, limit.rotationMin.z);
                }
                if (limit.rotationMax) {
                    offsetEuler.x = Math.min(offsetEuler.x, limit.rotationMax.x);
                    offsetEuler.y = Math.min(offsetEuler.y, limit.rotationMax.y);
                    offsetEuler.z = Math.min(offsetEuler.z, limit.rotationMax.z);
                }
                newEuler.set(
                    fixRot.x + offsetEuler.x,
                    fixRot.y + offsetEuler.y,
                    fixRot.z + offsetEuler.z
                );
            }

            bone.mesh.rotation.copy(newEuler);
            bone.mesh.updateMatrixWorld();

            if (get_samples) {
                const deltaEuler = new THREE.Euler().setFromQuaternion(localDeltaQuat, Format.euler_order || 'ZYX');
                results[bone.uuid] = {
                    euler: deltaEuler,
                    array: [
                        Math.radToDeg(deltaEuler.x),
                        Math.radToDeg(deltaEuler.y),
                        Math.radToDeg(deltaEuler.z),
                    ]
                };
            }
        });

        return get_samples ? results : undefined;
    }

    // 2-bone IK 解析求解，带 pole target 控制弯曲方向
    function efSolveTwoBoneIKWithPole(bones, target, controller, pole, boneWorldPositions, get_samples) {
        const hipWorld = boneWorldPositions[0].start;
        const kneeRest = boneWorldPositions[0].end;
        const ankleRest = boneWorldPositions[1].end;
        const thighLen = hipWorld.distanceTo(kneeRest);
        const legLen = kneeRest.distanceTo(ankleRest);
        const ankleTarget = controller.getWorldCenter(true);
        const poleWorld = pole.getWorldCenter(true);
        const dist = hipWorld.distanceTo(ankleTarget);

        // 不可达时回退到 FIK（完全伸直）
        if (dist >= thighLen + legLen - 1e-4 || dist <= Math.abs(thighLen - legLen) + 1e-4) {
            return null;
        }

        const AB = ankleTarget.clone().sub(hipWorld);
        const axis = AB.clone().normalize();
        const d1 = (thighLen * thighLen - legLen * legLen + dist * dist) / (2 * dist);
        const r = Math.sqrt(Math.max(0, thighLen * thighLen - d1 * d1));
        const circleCenter = hipWorld.clone().add(axis.clone().multiplyScalar(d1));

        const poleToCenter = poleWorld.clone().sub(circleCenter);
        let poleProj = poleToCenter.clone().sub(axis.clone().multiplyScalar(poleToCenter.dot(axis)));
        if (poleProj.lengthSq() < 1e-6) {
            const arbitrary = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
            poleProj = new THREE.Vector3().crossVectors(axis, arbitrary).normalize();
        }
        const kneeWorld = circleCenter.clone().add(poleProj.normalize().multiplyScalar(r));

        const fikBones = [
            { start: hipWorld, end: kneeWorld },
            { start: kneeWorld, end: ankleTarget }
        ];

        const results = {};
        bones.forEach((bone, i) => {
            const restWorld = boneWorldPositions[i].end.clone().sub(boneWorldPositions[i].start).normalize();
            const ikWorld = fikBones[i].end.clone().sub(fikBones[i].start).normalize();

            const deltaQuat = new THREE.Quaternion().setFromUnitVectors(restWorld, ikWorld);
            const parentQuat = bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion());
            const localDeltaQuat = parentQuat.clone().invert().multiply(deltaQuat).multiply(parentQuat);
            const fixQuat = new THREE.Quaternion().setFromEuler(
                bone.mesh.fix_rotation || new THREE.Euler(0, 0, 0),
                Format.euler_order || 'ZYX'
            );
            const newLocalQuat = localDeltaQuat.multiply(fixQuat);
            const newEuler = new THREE.Euler().setFromQuaternion(newLocalQuat, Format.euler_order || 'ZYX');

            // 应用 IK 角度限制（限制值表示相对于 rest pose 的偏移）
            const limit = controller.ik_limits && controller.ik_limits[bone.uuid];
            if (limit && limit.enabled) {
                const fixRot = bone.mesh.fix_rotation || new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
                const offsetEuler = new THREE.Euler(
                    newEuler.x - fixRot.x,
                    newEuler.y - fixRot.y,
                    newEuler.z - fixRot.z,
                    Format.euler_order || 'ZYX'
                );
                if (limit.rotationMin) {
                    offsetEuler.x = Math.max(offsetEuler.x, limit.rotationMin.x);
                    offsetEuler.y = Math.max(offsetEuler.y, limit.rotationMin.y);
                    offsetEuler.z = Math.max(offsetEuler.z, limit.rotationMin.z);
                }
                if (limit.rotationMax) {
                    offsetEuler.x = Math.min(offsetEuler.x, limit.rotationMax.x);
                    offsetEuler.y = Math.min(offsetEuler.y, limit.rotationMax.y);
                    offsetEuler.z = Math.min(offsetEuler.z, limit.rotationMax.z);
                }
                newEuler.set(
                    fixRot.x + offsetEuler.x,
                    fixRot.y + offsetEuler.y,
                    fixRot.z + offsetEuler.z
                );
            }

            bone.mesh.rotation.copy(newEuler);
            bone.mesh.updateMatrixWorld();

            if (get_samples) {
                const deltaEuler = new THREE.Euler().setFromQuaternion(localDeltaQuat, Format.euler_order || 'ZYX');
                results[bone.uuid] = {
                    euler: deltaEuler,
                    array: [
                        Math.radToDeg(deltaEuler.x),
                        Math.radToDeg(deltaEuler.y),
                        Math.radToDeg(deltaEuler.z),
                    ]
                };
            }
        });

        return get_samples ? results : undefined;
    }

    // 自定义 IK 求解，修复 Blockbench 原生 displayIK 对旋转骨骼 rest direction 的计算错误
    function efDisplayIK(animator, get_samples) {
        const null_object = animator.getElement();
        if (!null_object || !null_object.ik_target || !null_object.ik_source) return;

        const target = efFindNodeByUuid(null_object.ik_target);
        const source = efFindNodeByUuid(null_object.ik_source);
        if (!target || !source || !target.isChildOf(source)) return;

        // IK 禁用时，将控制器对齐到目标骨骼尾端，使其跟随 FK 运动
        if (null_object.ik_enabled === false) {
            const ankleWorld = efGetBoneTailWorldPosition(target);
            const parent = null_object.parent;
            let localPos = ankleWorld.clone();
            if (parent !== 'root' && parent.mesh) {
                parent.mesh.worldToLocal(localPos);
            }
            null_object.position[0] = localPos.x;
            null_object.position[1] = localPos.y;
            null_object.position[2] = localPos.z;
            null_object.preview_controller.updateTransform(null_object);
            return;
        }

        // 把目标骨骼也纳入 IK 链，末端使用骨骼尾端（ankle/wrist）而不是中心
        const bones = [];
        let cur = target;
        while (cur !== source) {
            if (cur instanceof ArmatureBone) bones.push(cur);
            cur = cur.parent;
        }
        if (source instanceof ArmatureBone) bones.push(source);
        if (!bones.length) return;
        bones.reverse();

        // 重置到 rest pose（位置、旋转、缩放都要还原）
        bones.forEach(bone => {
            if (bone.mesh.fix_position) bone.mesh.position.copy(bone.mesh.fix_position);
            if (bone.mesh.fix_rotation) bone.mesh.rotation.copy(bone.mesh.fix_rotation);
            if (bone.mesh.fix_scale) bone.mesh.scale.copy(bone.mesh.fix_scale);
            bone.mesh.updateMatrixWorld();
        });

        // 捕获 rest 下的世界位置
        const boneWorldPositions = [];
        bones.forEach((bone, i) => {
            const next = bones[i + 1];
            const start = bone.mesh.getWorldPosition(new THREE.Vector3());
            const end = next ? next.mesh.getWorldPosition(new THREE.Vector3()) : efGetBoneTailWorldPosition(bone);
            boneWorldPositions.push({ start, end });
        });

        const pole = null_object.ik_pole ? efFindNodeByUuid(null_object.ik_pole) : null;

        // 2-bone 链 + pole 时用解析 IK 求解，pole 控制膝盖/肘部弯曲方向
        if (bones.length === 2 && pole) {
            const result = efSolveTwoBoneIKWithPole(bones, target, null_object, pole, boneWorldPositions, get_samples);
            if (result !== null) return result;
            // 不可达时退化到 CCD 求解
        }

        // 使用 Three.js CCDIKSolver 求解
        // 在目标骨骼尾端创建一个临时 effector bone，这样 Leg 和 Thigh 都能被旋转
        const effectorBone = new THREE.Bone();
        effectorBone.name = target.name + '_ik_effector';
        const tailWorld = efGetBoneTailWorldPosition(target);
        const tailLocal = tailWorld.clone();
        target.mesh.worldToLocal(tailLocal);
        effectorBone.position.copy(tailLocal);
        target.mesh.add(effectorBone);
        effectorBone.updateMatrixWorld();

        const ikBones = bones.map(bone => bone.mesh);
        const effectorIndex = bones.length;
        ikBones.push(effectorBone);
        ikBones.push(null_object.mesh);
        const targetIndex = ikBones.length - 1;

        const links = [];
        for (let i = effectorIndex - 1; i >= 0; i--) {
            const bone = bones[i];
            const limit = null_object.ik_limits && null_object.ik_limits[bone.uuid];
            const link = { index: i, enabled: true };
            if (limit && limit.enabled) {
                if (limit.limitation) link.limitation = limit.limitation;
                // IK 限制值表示相对于 rest pose 的偏移，转换为绝对限制传入 solver
                const fixRot = bone.mesh.fix_rotation || new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
                if (limit.rotationMin) {
                    link.rotationMin = new THREE.Vector3(
                        fixRot.x + limit.rotationMin.x,
                        fixRot.y + limit.rotationMin.y,
                        fixRot.z + limit.rotationMin.z
                    );
                }
                if (limit.rotationMax) {
                    link.rotationMax = new THREE.Vector3(
                        fixRot.x + limit.rotationMax.x,
                        fixRot.y + limit.rotationMax.y,
                        fixRot.z + limit.rotationMax.z
                    );
                }
            }
            links.push(link);
        }

        const ik = {
            effector: effectorIndex,
            target: targetIndex,
            links: links,
            iteration: 10,
        };

        const skinnedMesh = { skeleton: { bones: ikBones } };
        const solver = new CCDIKSolver(skinnedMesh, [ik]);
        solver.update();

        // 移除临时 effector bone
        target.mesh.remove(effectorBone);

        // CCDIKSolver 直接修改了 bone.mesh.quaternion，同步回 Euler rotation
        bones.forEach(bone => {
            const euler = new THREE.Euler().setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
            bone.mesh.rotation.copy(euler);
            bone.mesh.updateMatrixWorld();
        });

        // 收集结果
        const results = {};
        if (get_samples) {
            bones.forEach(bone => {
                const restQuat = new THREE.Quaternion().setFromEuler(
                    bone.mesh.fix_rotation || new THREE.Euler(0, 0, 0),
                    Format.euler_order || 'ZYX'
                );
                const deltaQuat = bone.mesh.quaternion.clone().multiply(restQuat.clone().invert());
                const deltaEuler = new THREE.Euler().setFromQuaternion(deltaQuat, Format.euler_order || 'ZYX');
                results[bone.uuid] = {
                    euler: deltaEuler,
                    array: [
                        Math.radToDeg(deltaEuler.x),
                        Math.radToDeg(deltaEuler.y),
                        Math.radToDeg(deltaEuler.z),
                    ]
                };
            });
        }

        // 在 IK 结果上叠加骨骼自身旋转关键帧（手动旋转），实现 IK + FK 同时生效
        bones.forEach(bone => {
            const animator = Animation.selected ? Animation.selected.getBoneAnimator(bone) : null;
            if (animator && animator.rotation && animator.rotation.length) {
                const rotDeg = animator.interpolate('rotation', false);
                if (rotDeg) {
                    bone.mesh.rotation.x += Math.degToRad(rotDeg[0]);
                    bone.mesh.rotation.y += Math.degToRad(rotDeg[1]);
                    bone.mesh.rotation.z += Math.degToRad(rotDeg[2]);
                    bone.mesh.updateMatrixWorld();
                }
            }
        });

        // Blockbench showDefaultPose(true) 不会更新场景矩阵，
        // 但 Cube/Mesh 作为 bone 子对象需要完整场景矩阵更新才能跟随骨骼
        if (typeof Canvas !== 'undefined' && Canvas.scene) {
            Canvas.scene.updateMatrixWorld(true);
        }

        // 触发带骨骼权重 Mesh 的顶点形变更新，否则模型不会跟随骨骼运动
        if (typeof Animator !== 'undefined' && Animator.displayMeshDeformation) {
            Animator.displayMeshDeformation();
        }

        return get_samples ? results : undefined;
    }

    // 判断骨骼是否处于某个启用中 IK 控制器的链上
    function efIsBoneInActiveIKChain(bone) {
        for (const no of NullObject.all) {
            if (no.ik_enabled === false || !no.ik_target || !no.ik_source) continue;
            const source = efFindNodeByUuid(no.ik_source);
            const target = efFindNodeByUuid(no.ik_target);
            if (!source || !target) continue;
            const inChain = (bone === source || bone.isChildOf(source)) && (target === bone || target.isChildOf(bone));
            if (inChain) return true;
        }
        return false;
    }

    // 覆盖 BoneAnimator.displayRotation：IK 链上的骨骼由 efDisplayIK 统一叠加手动旋转，避免重复加
    const origDisplayRotation = BoneAnimator.prototype.displayRotation;
    BoneAnimator.prototype.displayRotation = function(arr, multiplier = 1) {
        const group = this.getGroup();
        if (group && group instanceof ArmatureBone && efIsBoneInActiveIKChain(group)) {
            return this;
        }
        return origDisplayRotation.call(this, arr, multiplier);
    };

    // 覆盖 NullObjectAnimator.displayIK，使所有带 ik_target/ik_source 的 NullObject 走自定义求解
    const origDisplayIK = NullObjectAnimator.prototype.displayIK;
    NullObjectAnimator.prototype.displayIK = function(get_samples) {
        const null_object = this.getElement();
        if (null_object && null_object.ik_target && null_object.ik_source) {
            return efDisplayIK(this, get_samples);
        }
        if (null_object && null_object.ik_controller) {
            const controller = efFindNodeByUuid(null_object.ik_controller);
            if (controller && controller.ik_target && controller.ik_source) {
                const anim = Animation.selected;
                const controllerAnimator = anim ? anim.getBoneAnimator(controller) : null;
                if (controllerAnimator && controllerAnimator.displayIK) {
                    controllerAnimator.displayIK(get_samples);
                }
            }
        }
        return origDisplayIK.call(this, get_samples);
    };

    const ikActions = [];

    // 创建 IK 控制器
    ikActions.push(new Action('ef_create_ik_controller', {
        name: tl('ef.ik.create_controller'),
        icon: 'fa-link',
        category: 'edit',
        condition: () => Modes.animate && ArmatureBone.selected.length > 0,
        searchable: true,
        children() {
            const targetBone = ArmatureBone.selected[0];
            const sources = efCollectSourceCandidates(targetBone);
            const existingController = efFindController(targetBone);
            return sources.map(source => ({
                name: source.name + ((existingController && existingController.ik_source === source.uuid) ? ' (✓)' : ''),
                icon: 'fa-link',
                marked: existingController && existingController.ik_source === source.uuid,
                click() {
                    const existing = efFindController(targetBone);
                    if (existing) {
                        Undo.initEdit({elements: [existing]});
                        existing.ik_source = source.uuid;
                        Undo.finishEdit(tl('ef.ik.change_source_undo'));
                    } else {
                        efCreateController(targetBone, source);
                    }
                    Animator.preview();
                }
            }));
        },
        click(event) {
            const targetBone = ArmatureBone.selected[0];
            const sources = efCollectSourceCandidates(targetBone);
            if (sources.length === 0) return;
            if (sources.length === 1) {
                const existing = efFindController(targetBone);
                if (existing) {
                    Undo.initEdit({elements: [existing]});
                    existing.ik_source = sources[0].uuid;
                    Undo.finishEdit(tl('ef.ik.change_source_undo'));
                } else {
                    efCreateController(targetBone, sources[0]);
                }
                Animator.preview();
                return;
            }
            new Menu('ef_create_ik_controller', this.children(this), {searchable: true}).show(event.target, this);
        }
    }));

    // 断开/删除 IK 控制器
    ikActions.push(new Action('ef_break_ik_controller', {
        name: tl('ef.ik.break_controller'),
        icon: 'fa-unlink',
        category: 'edit',
        condition: () => Modes.animate && ArmatureBone.selected.length > 0 && ArmatureBone.selected.some(b => efFindController(b)),
        click() {
            const controllers = [];
            ArmatureBone.selected.forEach(b => {
                const c = efFindController(b);
                if (c) {
                    controllers.push(c);
                    if (c.ik_pole) {
                        const pole = efFindNodeByUuid(c.ik_pole);
                        if (pole) controllers.push(pole);
                    }
                }
            });
            if (!controllers.length) return;
            Undo.initEdit({elements: controllers, outliner: true});
            controllers.forEach(c => c.remove());
            Undo.finishEdit(tl('ef.ik.break_undo'));
            Animator.preview();
        }
    }));

    // 烘焙 IK（复用 Blockbench 原生 bake_ik_animation，但会走自定义 displayIK）
    ikActions.push(new Action('ef_bake_ik_controller', {
        name: tl('ef.ik.bake'),
        icon: 'cake',
        category: 'edit',
        condition: () => Modes.animate && Animation.selected && ArmatureBone.selected.some(b => efFindController(b)),
        click() {
            if (BarItems.bake_ik_animation && BarItems.bake_ik_animation.condition && BarItems.bake_ik_animation.click) {
                BarItems.bake_ik_animation.click();
            }
        }
    }));

    // 切换 IK 控制器启用/禁用：禁用后可手动调整骨骼旋转
    ikActions.push(new Action('ef_toggle_ik_controller', {
        name: tl('ef.ik.toggle'),
        icon: 'toggle_on',
        category: 'edit',
        condition() {
            if (!Modes.animate || !Animation.selected) return false;
            const controller = NullObject.selected[0] || ArmatureBone.selected.map(b => efFindController(b)).find(c => c);
            return !!controller;
        },
        click() {
            let controller = NullObject.selected[0];
            if (!controller || !controller.ik_target) {
                controller = ArmatureBone.selected.map(b => efFindController(b)).find(c => c);
            }
            if (!controller) return;
            controller.ik_enabled = controller.ik_enabled !== false ? false : true;
            Undo.initEdit({elements: [controller]});
            Undo.finishEdit(controller.ik_enabled ? tl('ef.ik.enable_undo') : tl('ef.ik.disable_undo'));
            Animator.preview();
            Blockbench.showQuickMessage(controller.ik_enabled !== false ? tl('ef.ik.enabled') : tl('ef.ik.disabled'));
        }
    }));

    // 编辑 IK 角度限制
    ikActions.push(new Action('ef_ik_limits', {
        name: tl('ef.ik.limits'),
        icon: 'fa-sliders-h',
        category: 'edit',
        condition() {
            if (!Modes.animate || !Animation.selected) return false;
            const controller = NullObject.selected[0] || ArmatureBone.selected.map(b => efFindController(b)).find(c => c);
            return !!controller;
        },
        click() {
            let controller = NullObject.selected[0];
            if (!controller || !controller.ik_target) {
                controller = ArmatureBone.selected.map(b => efFindController(b)).find(c => c);
            }
            if (!controller) return;

            const target = efFindNodeByUuid(controller.ik_target);
            const source = efFindNodeByUuid(controller.ik_source);
            if (!target || !source) return;

            const bones = [];
            let cur = target;
            while (cur !== source) {
                if (cur instanceof ArmatureBone) bones.push(cur);
                cur = cur.parent;
            }
            if (source instanceof ArmatureBone) bones.push(source);
            bones.reverse();

            const form = {};
            bones.forEach(bone => {
                const limit = (controller.ik_limits && controller.ik_limits[bone.uuid]) || {};
                const defaultLimit = efGetDefaultIKLimit(bone) || {};
                const enabled = !!limit.enabled;
                const limitation = limit.limitation
                    ? limit.limitation.clone()
                    : (defaultLimit.limitation ? defaultLimit.limitation.clone() : new THREE.Vector3(0, 1, 0));
                const maxAxis = Math.abs(limitation.x) > Math.abs(limitation.y)
                    ? (Math.abs(limitation.x) > Math.abs(limitation.z) ? 'x' : 'z')
                    : (Math.abs(limitation.y) > Math.abs(limitation.z) ? 'y' : 'z');
                const defaultMin = defaultLimit.rotationMin
                    ? [Math.radToDeg(defaultLimit.rotationMin.x), Math.radToDeg(defaultLimit.rotationMin.y), Math.radToDeg(defaultLimit.rotationMin.z)]
                    : [0, -90, 0];
                const defaultMax = defaultLimit.rotationMax
                    ? [Math.radToDeg(defaultLimit.rotationMax.x), Math.radToDeg(defaultLimit.rotationMax.y), Math.radToDeg(defaultLimit.rotationMax.z)]
                    : [0, 0, 0];
                const minDeg = limit.rotationMin
                    ? [Math.radToDeg(limit.rotationMin.x), Math.radToDeg(limit.rotationMin.y), Math.radToDeg(limit.rotationMin.z)]
                    : defaultMin;
                const maxDeg = limit.rotationMax
                    ? [Math.radToDeg(limit.rotationMax.x), Math.radToDeg(limit.rotationMax.y), Math.radToDeg(limit.rotationMax.z)]
                    : defaultMax;

                form[bone.uuid + '_enabled'] = {
                    type: 'checkbox',
                    label: bone.name + ' ' + tl('ef.ik.enabled_suffix'),
                    value: enabled
                };
                form[bone.uuid + '_limitation'] = {
                    type: 'select',
                    label: bone.name + ' ' + tl('ef.ik.limitation_axis'),
                    options: { none: tl('ef.ik.none'), x: 'X', y: 'Y', z: 'Z' },
                    value: enabled ? maxAxis : 'none'
                };
                form[bone.uuid + '_min'] = {
                    type: 'vector',
                    dimensions: 3,
                    label: bone.name + ' ' + tl('ef.ik.min_deg'),
                    value: minDeg
                };
                form[bone.uuid + '_max'] = {
                    type: 'vector',
                    dimensions: 3,
                    label: bone.name + ' ' + tl('ef.ik.max_deg'),
                    value: maxDeg
                };
            });

            new Dialog('ef_ik_limits', {
                title: tl('ef.ik.limits_title'),
                form,
                onConfirm(result) {
                    Undo.initEdit({elements: [controller]});
                    controller.ik_limits = {};
                    bones.forEach(bone => {
                        const enabled = result[bone.uuid + '_enabled'];
                        if (!enabled) return;
                        const limitationStr = result[bone.uuid + '_limitation'];
                        const limitation = new THREE.Vector3(0, 0, 0);
                        if (limitationStr && limitationStr !== 'none') {
                            limitation[limitationStr] = 1;
                        }
                        const minDeg = result[bone.uuid + '_min'];
                        const maxDeg = result[bone.uuid + '_max'];
                        controller.ik_limits[bone.uuid] = {
                            enabled: true,
                            limitation: limitationStr !== 'none' ? limitation : undefined,
                            rotationMin: new THREE.Vector3(
                                Math.degToRad(minDeg[0]),
                                Math.degToRad(minDeg[1]),
                                Math.degToRad(minDeg[2])
                            ),
                            rotationMax: new THREE.Vector3(
                                Math.degToRad(maxDeg[0]),
                                Math.degToRad(maxDeg[1]),
                                Math.degToRad(maxDeg[2])
                            )
                        };
                    });
                    Undo.finishEdit(tl('ef.ik.edit_limits_undo'));
                    Animator.preview();
                }
            }).show();
        }
    }));

    // 添加到 ArmatureBone 右键菜单
    const origShowContextMenu = ArmatureBone.prototype.showContextMenu;
    ArmatureBone.prototype.showContextMenu = function(event) {
        if (!this.menu._efIKAdded) {
            this.menu.structure.push(new MenuSeparator('ef_ik'));
            this.menu.structure.push('ef_create_ik_controller');
            this.menu.structure.push('ef_break_ik_controller');
            this.menu.structure.push('ef_bake_ik_controller');
            this.menu.structure.push('ef_toggle_ik_controller');
            this.menu.structure.push('ef_ik_limits');
            this.menu._efIKAdded = true;
        }
        return origShowContextMenu.call(this, event);
    };

    // 添加到 NullObject（控制器/pole）右键菜单
    const origNullShowContextMenu = NullObject.prototype.showContextMenu;
    NullObject.prototype.showContextMenu = function(event) {
        if (!this.menu._efIKAdded) {
            this.menu.structure.push(new MenuSeparator('ef_ik'));
            this.menu.structure.push('ef_toggle_ik_controller');
            this.menu.structure.push('ef_ik_limits');
            this.menu._efIKAdded = true;
        }
        return origNullShowContextMenu.call(this, event);
    };

    return {
        cleanup() {
            NullObjectAnimator.prototype.displayIK = origDisplayIK;
            BoneAnimator.prototype.displayRotation = origDisplayRotation;
            ArmatureBone.prototype.showContextMenu = origShowContextMenu;
            NullObject.prototype.showContextMenu = origNullShowContextMenu;
            ikActions.forEach(a => a.delete());
        }
    };
}

// ============================================================
//  Plugin Registration
// ============================================================

let efIKCleanup = null;

Plugin.register('epicfight_export', {
    title: 'EpicFight Tools',
    author: 'zi_dou',
    description: 'Import EpicFight JSON assets and export to EpicFight JSON format',
    icon: 'gamepad',
    version: '0.3.0',
    variant: 'both',
    tags: ['Minecraft: Java Edition'],

    onload() {
        efRegisterTranslations();
        // Patch ArmatureBoneAnimator.interpolate 已移除 (导致画面消失)
        // 如需重新启用, 需要修复 this.group 问题
        const actImportMesh = new Action('ef_import_mesh', {
            name: tl('ef.import_mesh'),
            description: tl('ef.import_mesh.desc'),
            icon: 'view_in_ar',
            click: importEpicFightMesh
        });
        const actImportArmature = new Action('ef_import_armature', {
            name: tl('ef.import_armature'),
            description: tl('ef.import_armature.desc'),
            icon: 'account_tree',
            click: importEpicFightArmature
        });
        const actImportAnim = new Action('ef_import_animation', {
            name: tl('ef.import_animation'),
            description: tl('ef.import_animation.desc'),
            icon: 'movie',
            click: importEpicFightAnimation
        });

        const actModel = new Action('ef_export_model', {
            name: tl('ef.export_model'),
            description: tl('ef.export_model.desc'),
            icon: 'account_tree',
            click: exportModelWithContentChoice
        });

        const actAnim = new Action('ef_export_animation', {
            name: tl('ef.export_animation'),
            description: tl('ef.export_animation.desc'),
            icon: 'movie',
            click: exportAnimationWithFormatChoice
        });

        const actAnimBatch = new Action('ef_export_animation_batch', {
            name: tl('ef.export_animation_batch'),
            description: tl('ef.export_animation_batch.desc'),
            icon: 'movie_filter',
            click: exportAnimationBatchWithChoice
        });

        const actEntity = new Action('ef_export_entity', {
            name: tl('ef.export_entity'),
            description: tl('ef.export_entity.desc'),
            icon: 'box',
            click: exportEntityWithChoice
        });

        // File > Import
        MenuBar.addAction(actImportMesh, 'file.import');
        MenuBar.addAction(actImportArmature, 'file.import');
        MenuBar.addAction(actImportAnim, 'file.import');

        // File > Export
        MenuBar.addAction(actModel, 'file.export');
        MenuBar.addAction(actAnim, 'file.export');
        MenuBar.addAction(actAnimBatch, 'file.export');
        MenuBar.addAction(actEntity, 'file.export');

        // Tools menu (quick access)
        MenuBar.addAction(actImportMesh, 'tools');
        MenuBar.addAction(actImportArmature, 'tools');
        MenuBar.addAction(actImportAnim, 'tools');

        // 注册 ArmatureBone IK 支持
        efIKCleanup = efSetupIKSupport();
    },

    onunload() {
        ['ef_import_mesh', 'ef_import_armature', 'ef_import_animation', 'ef_export_model', 'ef_export_animation', 'ef_export_animation_batch', 'ef_export_entity'].forEach(function(id) {
            const action = Action.actions[id];
            if (action) action.delete();
        });
        if (efIKCleanup) {
            efIKCleanup.cleanup();
            efIKCleanup = null;
        }
    }
});
