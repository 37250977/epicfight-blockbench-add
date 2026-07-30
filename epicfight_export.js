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
        'ef.ik.chain_length': 'Chain Length (0 = All Ancestors)',
        'ef.ik.influence': 'IK Influence',
        'ef.ik.iterations': 'CCD Iterations',
        'ef.ik.pole_iterations': 'Pole Convergence Passes',
        'ef.ik.tolerance': 'Convergence Tolerance',
        'ef.ik.pole_angle': 'Pole Angle (deg)',
        'ef.ik.twist_stiffness': 'Twist Stiffness',
        'ef.ik.none': 'None',
        'ef.ik.edit_limits_undo': 'Edit IK angle limits',
        'ef.ik.create_undo': 'Create IK controller',
        'ef.ik.change_source_undo': 'Change IK source',
        'ef.ik.break_undo': 'Break IK controller',
        'ef.ik.enable_undo': 'Enable IK controller',
        'ef.ik.disable_undo': 'Disable IK controller',
        'ef.rig.rebuild': 'Rebuild Humanoid IK/FK Rig',
        'ef.rig.bake': 'Bake Humanoid Rig',
        'ef.rig.validate': 'Validate Humanoid Rig',
        'ef.rig.rebuilt': 'Humanoid rig rebuilt',
        'ef.rig.baked': 'Humanoid rig baked and validated',
        'ef.rig.valid': 'Humanoid rig is valid',
        'ef.rig.invalid': 'Humanoid Rig Error',
        'ef.rig.rebuild_undo': 'Rebuild humanoid IK/FK rig',
        'ef.rig.bake_undo': 'Bake humanoid IK/FK rig'
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
        'ef.ik.chain_length': '链长（0 = 全部祖先）',
        'ef.ik.influence': 'IK 影响权重',
        'ef.ik.iterations': 'CCD 迭代次数',
        'ef.ik.pole_iterations': 'Pole 二次收敛次数',
        'ef.ik.tolerance': '收敛容差',
        'ef.ik.pole_angle': '极向角 (度)',
        'ef.ik.twist_stiffness': '扭转刚度',
        'ef.ik.none': '无',
        'ef.ik.edit_limits_undo': '编辑 IK 角度限制',
        'ef.ik.create_undo': '创建 IK 控制器',
        'ef.ik.change_source_undo': '更改 IK 源',
        'ef.ik.break_undo': '断开 IK 控制器',
        'ef.ik.enable_undo': '启用 IK 控制器',
        'ef.ik.disable_undo': '禁用 IK 控制器',
        'ef.rig.rebuild': '一键重建人形 IK/FK',
        'ef.rig.bake': '烘焙人形控制器',
        'ef.rig.validate': '验证人形控制器',
        'ef.rig.rebuilt': '人形 IK/FK 已重建',
        'ef.rig.baked': '人形控制器已烘焙并通过验证',
        'ef.rig.valid': '人形控制器验证通过',
        'ef.rig.invalid': '人形控制器错误',
        'ef.rig.rebuild_undo': '重建人形 IK/FK',
        'ef.rig.bake_undo': '烘焙人形 IK/FK'
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
    if (typeof NullObject === 'undefined' || typeof NullObjectAnimator === 'undefined') {
        console.warn('[EF] NullObject not available, IK support disabled');
        return null;
    }

    const ikProperties = [];
    if (typeof Property !== 'undefined') {
        ikProperties.push(new Property(NullObject, 'object', 'ef_ik'));
        if (!NullObject.properties.rotation) {
            ikProperties.push(new Property(NullObject, 'vector', 'rotation'));
        }
    }

    const originalNullObjectRotatable = NullObject.prototype.constructor.behavior.rotatable;
    NullObject.prototype.constructor.behavior.rotatable = true;
    const originalNullChannels = NullObjectAnimator.prototype.channels;
    NullObjectAnimator.prototype.channels = Object.assign({}, originalNullChannels, {
        rotation: {name: tl('timeline.rotation'), mutable: true, transform: true, max_data_points: 2}
    });

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
            const tolerance = Math.max(0, Number(ik.tolerance) || 0);
            const toleranceSq = tolerance * tolerance;
            for (let i = 0; i < iteration; i++) {
                if (tolerance > 0) {
                    _effectorPos.setFromMatrixPosition(effector.matrixWorld);
                    if (_effectorPos.distanceToSquared(_targetPos) <= toleranceSq) break;
                }
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
                    _targetVec.subVectors(_targetPos, _linkPos);
                    _targetVec.applyQuaternion(_invLinkQ);
                    if (_effectorVec.lengthSq() < 1e-12 || _targetVec.lengthSq() < 1e-12) continue;
                    _effectorVec.normalize();
                    _targetVec.normalize();
                    let angle = _targetVec.dot(_effectorVec);
                    if (angle > 1.0) angle = 1.0;
                    else if (angle < -1.0) angle = -1.0;
                    angle = math.acos(angle);
                    if (angle < 1e-5) continue;
                    if (ik.minAngle !== undefined && angle < ik.minAngle) angle = ik.minAngle;
                    if (ik.maxAngle !== undefined && angle > ik.maxAngle) angle = ik.maxAngle;
                    _axis.crossVectors(_effectorVec, _targetVec);
                    if (_axis.lengthSq() < 1e-12) {
                        _vector.set(Math.abs(_effectorVec.x) < 0.9 ? 1 : 0, Math.abs(_effectorVec.x) < 0.9 ? 0 : 1, 0);
                        _axis.crossVectors(_effectorVec, _vector);
                    }
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
                        _vector.set(link.rotation.x, link.rotation.y, link.rotation.z);
                        if (rotationMin !== undefined) _vector.max(rotationMin);
                        if (rotationMax !== undefined) _vector.min(rotationMax);
                        link.rotation.setFromVector3(_vector);
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

    const scene = (typeof Canvas !== 'undefined' && Canvas.scene) ? Canvas.scene : ((typeof Project !== 'undefined' && Project.model_3d) ? Project.model_3d : null);
    const originalNullUpdateTransform = NullObject.preview_controller.updateTransform;
    const originalNullUpdateSelection = NullObject.preview_controller.updateSelection;
    const originalNullDisplayFrame = NullObjectAnimator.prototype.displayFrame;
    const originalPreviewRaycast = typeof Preview !== 'undefined' ? Preview.prototype.raycast : null;
    const controllerVisuals = new Map();
    const patchedIKMenus = new Map();
    const ikLineMaterial = new THREE.LineBasicMaterial({
        color: 0xffb13b,
        depthTest: false,
        transparent: true,
        opacity: 0.9
    });
    const ikLineGeometry = new THREE.BufferGeometry();
    const ikLineHelper = new THREE.LineSegments(ikLineGeometry, ikLineMaterial);
    ikLineHelper.name = 'ef_ik_chain_helper';
    ikLineHelper.renderOrder = 1000;
    ikLineHelper.frustumCulled = false;
    ikLineHelper.visible = false;
    if (scene) scene.add(ikLineHelper);

    function efDisposeControllerVisual(visual) {
        if (!visual) return;
        if (visual.parent) visual.parent.remove(visual);
        if (visual.userData.efControllerUuid) controllerVisuals.delete(visual.userData.efControllerUuid);
        visual.traverse(object => {
            if (object.geometry) object.geometry.dispose();
            if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
            else if (object.material) object.material.dispose();
        });
    }

    function efGetControllerVisualStyle(element) {
        const config = element.ef_ik || {};
        const side = /_r$/i.test(config.limb || element.name) ? 'right' : /_l$/i.test(config.limb || element.name) ? 'left' : '';
        const color = side === 'right' ? 0xef4444 : side === 'left' ? 0x22c55e : config.role === 'master' || config.layer === 'root' ? 0xfacc15 : config.layer === 'torso' ? 0x3b82f6 : config.layer === 'chest' ? 0x22d3ee : config.role === 'target' ? 0xf97316 : 0xa855f7;
        const shape = config.role === 'master' ? 'master' : config.role === 'target' ? 'box' : config.role === 'pole' ? 'diamond' : config.layer === 'root' ? 'root_ring' : config.layer === 'torso' ? 'torso_ring' : config.layer === 'chest' ? 'chest_ring' : 'ring';
        return {color, shape, key: [config.role, config.layer, config.limb, shape, 'visual_scale_0.5'].join(':')};
    }

    function efCreateControllerVisual(element, style) {
        const group = new THREE.Group();
        const material = new THREE.MeshBasicMaterial({
            color: style.color,
            wireframe: true,
            transparent: true,
            opacity: 0.96,
            depthTest: false,
            depthWrite: false
        });
        const addMesh = (geometry, rotation, scale) => {
            const mesh = new THREE.Mesh(geometry, material.clone());
            if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
            if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
            mesh.scale.multiplyScalar(0.25);
            mesh.userData.efControllerUuid = element.uuid;
            mesh.userData.element = element;
            mesh.no_export = true;
            mesh.renderOrder = 1002;
            group.add(mesh);
            return mesh;
        };
        if (style.shape === 'master') {
            addMesh(new THREE.BoxGeometry(28, 2, 20));
        } else if (style.shape === 'box') {
            addMesh(new THREE.BoxGeometry(11, 11, 11));
        } else if (style.shape === 'diamond') {
            addMesh(new THREE.OctahedronGeometry(5.5, 0));
            addMesh(new THREE.TorusGeometry(6.5, 0.35, 6, 24), [Math.PI / 2, 0, 0], [1, 1, 0.65]);
        } else {
            const radius = style.shape === 'root_ring' ? 15 : style.shape === 'torso_ring' ? 12 : style.shape === 'chest_ring' ? 14 : 9;
            addMesh(new THREE.TorusGeometry(radius, 0.55, 8, 40), [Math.PI / 2, 0, 0]);
            if (style.shape === 'chest_ring') {
                addMesh(new THREE.TorusGeometry(radius * 0.72, 0.4, 8, 32), [0, Math.PI / 2, 0]);
                addMesh(new THREE.TorusGeometry(radius * 0.72, 0.4, 8, 32), [0, 0, 0]);
            }
        }
        material.dispose();
        group.name = 'ef_ik_controller_visual';
        group.userData.efIKVisualKey = style.key;
        group.userData.efIKColor = style.color;
        group.userData.efControllerUuid = element.uuid;
        group.no_export = true;
        group.renderOrder = 1001;
        return group;
    }

    function efUpdateControllerVisual(element) {
        if (!element || !element.mesh) return;
        const role = element.ef_ik && element.ef_ik.role;
        let visual = controllerVisuals.get(element.uuid);
        if (!role) {
            efDisposeControllerVisual(visual);
            return;
        }
        const style = efGetControllerVisualStyle(element);
        if (visual && visual.userData.efIKVisualKey !== style.key) {
            efDisposeControllerVisual(visual);
            visual = null;
        }
        if (!visual) {
            visual = efCreateControllerVisual(element, style);
            if (scene) scene.add(visual);
            controllerVisuals.set(element.uuid, visual);
        }
        element.mesh.updateMatrixWorld(true);
        element.mesh.getWorldPosition(visual.position);
        element.mesh.getWorldQuaternion(visual.quaternion);
        visual.updateMatrixWorld(true);
        const color = element.selected && typeof gizmo_colors !== 'undefined' ? gizmo_colors.outline : style.color;
        visual.traverse(object => {
            if (object.material && object.material.color) object.material.color.set(color);
        });
        visual.userData.efIKColor = style.color;
        visual.visible = element.visibility !== false && element.mesh.visible !== false;
    }

    function efApplyNullRotation(element) {
        if (!element || !element.mesh) return;
        const rotation = Array.isArray(element.rotation) ? element.rotation : [0, 0, 0];
        element.mesh.rotation.set(
            Math.degToRad(Number(rotation[0]) || 0),
            Math.degToRad(Number(rotation[1]) || 0),
            Math.degToRad(Number(rotation[2]) || 0),
            Format.euler_order || 'ZYX'
        );
        if (!element.mesh.fix_rotation) element.mesh.fix_rotation = new THREE.Euler();
        element.mesh.fix_rotation.copy(element.mesh.rotation);
    }

    NullObject.preview_controller.updateTransform = function(element) {
        originalNullUpdateTransform.call(this, element);
        efApplyNullRotation(element);
        efUpdateControllerVisual(element);
    };
    NullObject.preview_controller.updateSelection = function(element) {
        originalNullUpdateSelection.call(this, element);
        const role = element && element.ef_ik && element.ef_ik.role;
        if (role && element.mesh && element.mesh.material) {
            const style = efGetControllerVisualStyle(element);
            const color = element.selected && typeof gizmo_colors !== 'undefined' ? gizmo_colors.outline : style.color;
            element.mesh.material.color.set(color);
        }
        efUpdateControllerVisual(element);
    };
    if (originalPreviewRaycast) {
        Preview.prototype.raycast = function(event, options) {
            const nativeHit = originalPreviewRaycast.call(this, event, options);
            if (typeof Modes === 'undefined' || !Modes.animate || typeof Animation === 'undefined' || !Animation.selected) return nativeHit;
            const pickMeshes = [];
            let hasHumanoidController = false;
            controllerVisuals.forEach((visual, uuid) => {
                const element = efFindNodeByUuid(uuid);
                if (!element || !visual || !visual.visible || element.visibility === false || element.locked === true) return;
                if (element.ef_ik && element.ef_ik.rig === 'epicfight_humanoid') hasHumanoidController = true;
                visual.traverse(object => {
                    if (object.isMesh && object.visible !== false) pickMeshes.push(object);
                });
            });
            if (!hasHumanoidController) return nativeHit;
            const controllerIntersects = this.raycaster.intersectObjects(pickMeshes, false);
            const controllerHit = controllerIntersects[0];
            if (controllerHit) {
                const element = controllerHit.object.userData.element || efFindNodeByUuid(controllerHit.object.userData.efControllerUuid);
                if (element) return {type: 'element', event, intersects: controllerIntersects, element};
            }
            const nativeElement = nativeHit && nativeHit.element;
            const isCube = typeof Cube !== 'undefined' && nativeElement instanceof Cube;
            const isMesh = typeof Blockbench !== 'undefined' && Blockbench.Mesh && nativeElement instanceof Blockbench.Mesh;
            const isTextureMesh = typeof TextureMesh !== 'undefined' && nativeElement instanceof TextureMesh;
            return isCube || isMesh || isTextureMesh ? null : nativeHit;
        };
    }
    NullObjectAnimator.prototype.displayFrame = function(multiplier = 1) {
        if (!this.doRender()) return;
        const element = this.getElement();
        if (!element || !efResolveController(element)) {
            return originalNullDisplayFrame.call(this, multiplier);
        }
        if (!this.rotation) this.rotation = [];
        if (element.mesh.fix_rotation) element.mesh.rotation.copy(element.mesh.fix_rotation);
        if (!this.muted.position) this.displayPosition(this.interpolate('position'), multiplier);
        if (!this.muted.rotation) {
            const rotation = this.interpolate('rotation');
            if (rotation) {
                element.mesh.rotation.x += Math.degToRad(rotation[0] || 0) * multiplier;
                element.mesh.rotation.y += Math.degToRad(rotation[1] || 0) * multiplier;
                element.mesh.rotation.z += Math.degToRad(rotation[2] || 0) * multiplier;
            }
        }
        element.mesh.updateMatrixWorld(true);
        efUpdateControllerVisual(element);
        const config = efGetFKConfig(element) || efGetMasterConfig(element);
        if (config) efDisplayFK(element);
        else this.displayIK();
        efUpdateIKLineHelper();
    };

    const updateIKVisuals = function() {
        const active = new Set(NullObject.all.map(element => element.uuid));
        [...controllerVisuals.entries()].forEach(([uuid, visual]) => {
            if (!active.has(uuid)) efDisposeControllerVisual(visual);
        });
        NullObject.all.forEach(element => {
            if (element.ef_ik && element.mesh) NullObject.preview_controller.updateSelection(element);
        });
        efUpdateIKLineHelper();
    };
    Blockbench.on('update_selection', updateIKVisuals);
    Blockbench.on('update_view', updateIKVisuals);

    function efFindNodeByUuid(uuid) {
        if (!uuid) return null;
        return [...Group.all, ...ArmatureBone.all, ...Locator.all, ...NullObject.all].find(node => node.uuid === uuid);
    }

    function efGetNodeWorldPosition(node) {
        if (node && node.mesh && node.mesh.getWorldPosition) {
            node.mesh.updateMatrixWorld(true);
            return node.mesh.getWorldPosition(new THREE.Vector3());
        }
        return node && node.getWorldCenter ? node.getWorldCenter(true) : new THREE.Vector3();
    }

    // 查找 IK source 下作为 pole target 参考的 helper bone（knee/elbow），排除目标骨骼自身
    function efFindPoleHelperBone(sourceBone, targetBone) {
        if (!(sourceBone instanceof ArmatureBone) || !(targetBone instanceof ArmatureBone)) return null;
        const sideMatch = targetBone.name.match(/_([lr])$/i);
        const helperType = /^(hand|tool)_/i.test(targetBone.name) ? 'elbow' : 'knee';
        const helperPattern = new RegExp('^' + helperType + (sideMatch ? '_' + sideMatch[1] : ''), 'i');
        const siblings = targetBone.parent && targetBone.parent.children ? targetBone.parent.children : [];
        const sibling = siblings.find(child => child instanceof ArmatureBone && helperPattern.test(child.name));
        if (sibling) return sibling;
        const stack = sourceBone.children.slice();
        while (stack.length) {
            const child = stack.shift();
            if (child instanceof ArmatureBone && child !== targetBone && helperPattern.test(child.name)) return child;
            if (child.children) stack.push(...child.children);
        }
        return null;
    }

    function efUsesBoneOriginAsEffector(bone) {
        return bone instanceof ArmatureBone && /^(hand|tool)_/i.test(bone.name);
    }

    function efGetIKEffectorWorldPosition(bone) {
        return efUsesBoneOriginAsEffector(bone) ? efGetNodeWorldPosition(bone) : efGetBoneTailWorldPosition(bone);
    }

    function efGetIKOwner(target) {
        if (!(target instanceof ArmatureBone)) return null;
        return efUsesBoneOriginAsEffector(target) ? target.parent : target;
    }

    function efCollectIKChain(target, chainLength) {
        const bones = [];
        let current = efGetIKOwner(target);
        const limit = Math.max(0, Math.floor(Number(chainLength) || 0));
        while (current && current !== 'root' && current instanceof ArmatureBone) {
            bones.push(current);
            if (limit > 0 && bones.length >= limit) break;
            current = current.parent;
        }
        bones.reverse();
        return bones;
    }

    function efGetMaximumChainLength(target) {
        let length = 0;
        let current = efGetIKOwner(target);
        while (current && current !== 'root' && current instanceof ArmatureBone) {
            length++;
            current = current.parent;
        }
        return length;
    }

    function efGetIKConfig(controller) {
        return controller && controller.ef_ik && controller.ef_ik.role === 'target' ? controller.ef_ik : null;
    }

    function efGetPoleConfig(pole) {
        return pole && pole.ef_ik && pole.ef_ik.role === 'pole' ? pole.ef_ik : null;
    }

    function efGetFKConfig(controller) {
        return controller && controller.ef_ik && controller.ef_ik.role === 'fk' ? controller.ef_ik : null;
    }

    function efGetMasterConfig(controller) {
        return controller && controller.ef_ik && controller.ef_ik.role === 'master' ? controller.ef_ik : null;
    }

    function efGetOwningArmature(node) {
        let current = node;
        while (current && current !== 'root') {
            if (current instanceof Armature) return current;
            current = current.parent;
        }
        return null;
    }

    function efGetSelectedArmatureBone() {
        const selectedBone = ArmatureBone.selected && ArmatureBone.selected[0];
        if (selectedBone) return selectedBone;
        const selectedNull = NullObject.selected && NullObject.selected[0];
        const controller = efResolveController(selectedNull);
        const config = controller && controller.ef_ik;
        const target = config && efFindNodeByUuid(config.target);
        return target instanceof ArmatureBone ? target : null;
    }

    function efGetArmatureBones(armature) {
        const bones = [];
        const visit = node => {
            if (node instanceof ArmatureBone) bones.push(node);
            if (node && node.children) node.children.forEach(visit);
        };
        if (armature && armature.children) armature.children.forEach(visit);
        return bones;
    }

    function efGetHumanoidRig(selectedBone) {
        const anchorBone = selectedBone || efGetSelectedArmatureBone();
        const armature = efGetOwningArmature(anchorBone);
        const byName = {};
        const duplicates = [];
        efGetArmatureBones(armature).forEach(bone => {
            const key = String(bone.name || '').toLowerCase();
            if (byName[key]) duplicates.push(bone.name);
            else byName[key] = bone;
        });
        const names = ['Root', 'Torso', 'Chest', 'Head', 'Thigh_R', 'Leg_R', 'Knee_R', 'Thigh_L', 'Leg_L', 'Knee_L', 'Shoulder_R', 'Arm_R', 'Hand_R', 'Tool_R', 'Elbow_R', 'Shoulder_L', 'Arm_L', 'Hand_L', 'Tool_L', 'Elbow_L'];
        const bones = {};
        const missing = [];
        names.forEach(name => {
            const bone = byName[name.toLowerCase()];
            if (bone) bones[name] = bone;
            else missing.push(name);
        });
        const isChildOf = (child, parent) => {
            let current = child && child.parent;
            while (current && current !== 'root') {
                if (current === parent) return true;
                current = current.parent;
            }
            return false;
        };
        const invalid = [];
        if (!armature) invalid.push('No Armature');
        if (!missing.length && !duplicates.length) {
            [['Torso', 'Root'], ['Chest', 'Torso'], ['Thigh_R', 'Root'], ['Leg_R', 'Thigh_R'], ['Thigh_L', 'Root'], ['Leg_L', 'Thigh_L'], ['Shoulder_R', 'Chest'], ['Arm_R', 'Shoulder_R'], ['Hand_R', 'Arm_R'], ['Tool_R', 'Hand_R'], ['Shoulder_L', 'Chest'], ['Arm_L', 'Shoulder_L'], ['Hand_L', 'Arm_L'], ['Tool_L', 'Hand_L']].forEach(pair => {
                if (!isChildOf(bones[pair[0]], bones[pair[1]])) invalid.push(pair[1] + ' > ' + pair[0]);
            });
        }
        return {
            valid: !!armature && missing.length === 0 && duplicates.length === 0 && invalid.length === 0,
            armature,
            bones,
            missing,
            duplicates,
            invalid
        };
    }
    function efGetArmatureIKNodes(armature) {
        return NullObject.all.filter(node => {
            const controller = efResolveController(node);
            const config = controller && efGetIKConfig(controller);
            const target = config && efFindNodeByUuid(config.target);
            return target instanceof ArmatureBone && efGetOwningArmature(target) === armature;
        });
    }

    function efGetRigControllers(armature) {
        return NullObject.all.filter(node => {
            if (!node.ef_ik || node.ef_ik.rig !== 'epicfight_humanoid') return false;
            if (!armature) return true;
            const target = efFindNodeByUuid(node.ef_ik.target);
            if (target instanceof ArmatureBone) return efGetOwningArmature(target) === armature;
            const controller = efResolveController(node);
            const controllerTarget = controller && efFindNodeByUuid(controller.ef_ik.target);
            return controllerTarget instanceof ArmatureBone && efGetOwningArmature(controllerTarget) === armature;
        });
    }

    function efResolveController(node) {
        if (efGetIKConfig(node) || efGetFKConfig(node) || efGetMasterConfig(node)) return node;
        const poleConfig = efGetPoleConfig(node);
        const controller = poleConfig ? efFindNodeByUuid(poleConfig.controller) : null;
        return efGetIKConfig(controller) ? controller : null;
    }

    function efToVector3(value, fallback) {
        if (value && value.isVector3) return value.clone();
        if (Array.isArray(value)) return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
        if (value && typeof value === 'object') return new THREE.Vector3(Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0);
        return fallback ? fallback.clone() : new THREE.Vector3();
    }

    function efDecomposeSwingTwist(quaternion, axis, swing, twist) {
        const projected = new THREE.Vector3(quaternion.x, quaternion.y, quaternion.z).projectOnVector(axis);
        twist.set(projected.x, projected.y, projected.z, quaternion.w).normalize();
        if (quaternion.dot(twist) < 0) twist.set(-twist.x, -twist.y, -twist.z, -twist.w);
        swing.copy(twist).invert().premultiply(quaternion);
    }

    function efApplyTwistStiffness(localQuaternion, restQuaternion, stiffness) {
        if (!(stiffness > 0)) return localQuaternion;
        const delta = restQuaternion.clone().invert().multiply(localQuaternion);
        const swing = new THREE.Quaternion();
        const twist = new THREE.Quaternion();
        efDecomposeSwingTwist(delta, new THREE.Vector3(0, 1, 0), swing, twist);
        twist.slerp(new THREE.Quaternion(), THREE.MathUtils.clamp(stiffness, 0, 1));
        return restQuaternion.clone().multiply(swing).multiply(twist);
    }

    function efApplyIKLimit(localQuaternion, restQuaternion, limit) {
        if (!limit || !limit.enabled) return localQuaternion;
        const order = Format.euler_order || 'ZYX';
        const deltaQuaternion = restQuaternion.clone().invert().multiply(localQuaternion);
        const deltaEuler = new THREE.Euler().setFromQuaternion(deltaQuaternion, order);
        const rotationMin = limit.rotationMin ? efToVector3(limit.rotationMin) : null;
        const rotationMax = limit.rotationMax ? efToVector3(limit.rotationMax) : null;
        if (rotationMin) {
            deltaEuler.x = Math.max(deltaEuler.x, rotationMin.x);
            deltaEuler.y = Math.max(deltaEuler.y, rotationMin.y);
            deltaEuler.z = Math.max(deltaEuler.z, rotationMin.z);
        }
        if (rotationMax) {
            deltaEuler.x = Math.min(deltaEuler.x, rotationMax.x);
            deltaEuler.y = Math.min(deltaEuler.y, rotationMax.y);
            deltaEuler.z = Math.min(deltaEuler.z, rotationMax.z);
        }
        return restQuaternion.clone().multiply(new THREE.Quaternion().setFromEuler(deltaEuler));
    }

    function efApplyBoneAnimationRotation(bone) {
        const animator = Animation.selected ? Animation.selected.getBoneAnimator(bone) : null;
        if (!animator || !animator.rotation || !animator.rotation.length) return;
        const rotation = animator.interpolate('rotation', false);
        if (!rotation) return;
        const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            Math.degToRad(rotation[0] || 0),
            Math.degToRad(rotation[1] || 0),
            Math.degToRad(rotation[2] || 0),
            Format.euler_order || 'ZYX'
        ));
        bone.mesh.quaternion.multiply(offset);
        bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
        bone.mesh.updateMatrixWorld(true);
    }

    function efCollectIKSamples(bones, controller) {
        const results = {};
        bones.forEach(bone => {
            const restRotation = bone.mesh.fix_rotation
                ? bone.mesh.fix_rotation.clone()
                : new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
            restRotation.order = Format.euler_order || restRotation.order;
            const restQuaternion = new THREE.Quaternion().setFromEuler(restRotation);
            const deltaQuaternion = restQuaternion.invert().multiply(bone.mesh.quaternion);
            const deltaEuler = new THREE.Euler().setFromQuaternion(deltaQuaternion, Format.euler_order || 'ZYX');
            results[bone.uuid] = {
                euler: deltaEuler,
                array: efMakeEulerContinuous(controller, bone, [
                    Math.radToDeg(deltaEuler.x),
                    Math.radToDeg(deltaEuler.y),
                    Math.radToDeg(deltaEuler.z)
                ])
            };
        });
        return results;
    }

    function efMakeEulerContinuous(controller, bone, values) {
        const time = typeof Timeline !== 'undefined' ? Timeline.time : 0;
        if (!controller._ef_ik_sample_state || time < controller._ef_ik_sample_state.time) {
            controller._ef_ik_sample_state = {time, values: {}};
        }
        const previous = controller._ef_ik_sample_state.values[bone.uuid];
        const continuous = values.slice();
        if (previous) {
            for (let i = 0; i < 3; i++) {
                while (continuous[i] - previous[i] > 180) continuous[i] -= 360;
                while (continuous[i] - previous[i] < -180) continuous[i] += 360;
            }
        }
        controller._ef_ik_sample_state.time = time;
        controller._ef_ik_sample_state.values[bone.uuid] = continuous.slice();
        return continuous;
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

    function efComputePoleWorldPosition(chainBones, targetBone, helperBone) {
        const sourceWorld = efGetNodeWorldPosition(chainBones[0]);
        const jointWorld = efGetNodeWorldPosition(chainBones[chainBones.length - 1]);
        const effectorWorld = efGetIKEffectorWorldPosition(targetBone);
        const chainAxis = effectorWorld.clone().sub(sourceWorld);
        const firstLength = sourceWorld.distanceTo(jointWorld);
        const secondLength = jointWorld.distanceTo(effectorWorld);
        const limbScale = Math.max(firstLength, secondLength, 1);
        const epsilonSq = Math.pow(limbScale * 1e-4, 2);
        const axis = chainAxis.lengthSq() > epsilonSq ? chainAxis.clone().normalize() : new THREE.Vector3(0, 1, 0);
        let helperTail = null;
        let poleDir = null;

        if (helperBone && helperBone.mesh) {
            helperTail = efGetBoneTailWorldPosition(helperBone);
            poleDir = helperTail.clone().sub(jointWorld);
            poleDir.sub(axis.clone().multiplyScalar(poleDir.dot(axis)));
            if (poleDir.lengthSq() < epsilonSq) poleDir = null;
        }

        if (!poleDir) {
            poleDir = jointWorld.clone().sub(sourceWorld);
            poleDir.sub(axis.clone().multiplyScalar(poleDir.dot(axis)));
        }

        if (poleDir.lengthSq() < epsilonSq) {
            const references = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
            const reference = references.sort((a, b) => Math.abs(a.dot(axis)) - Math.abs(b.dot(axis)))[0];
            poleDir = reference.clone().sub(axis.clone().multiplyScalar(reference.dot(axis)));
        }

        poleDir.normalize();
        const helperReach = helperTail ? Math.max(0, helperTail.clone().sub(jointWorld).dot(poleDir)) : 0;
        const clearance = THREE.MathUtils.clamp(limbScale * 0.15, 0.25, limbScale * 0.35);
        const offsetDistance = Math.max(helperReach + clearance, limbScale * 0.75);
        return jointWorld.clone().add(poleDir.multiplyScalar(offsetDistance));
    }

    function efFindController(targetBone) {
        return NullObject.all.find(no => {
            const config = efGetIKConfig(no);
            return config && config.target === targetBone.uuid;
        });
    }

    function efFindPole(controller) {
        const config = efGetIKConfig(controller);
        if (!config || !config.pole) return null;
        const pole = efFindNodeByUuid(config.pole);
        const poleConfig = efGetPoleConfig(pole);
        return poleConfig && poleConfig.controller === controller.uuid ? pole : null;
    }

    function efGetSelectedController() {
        const selectedNull = NullObject.selected && NullObject.selected[0];
        const resolved = efResolveController(selectedNull);
        if (resolved) return resolved;
        const selectedBone = ArmatureBone.selected && ArmatureBone.selected[0];
        return selectedBone ? efFindController(selectedBone) : null;
    }

    function efUpdateIKLineHelper() {
        if (!ikLineHelper || !ikLineGeometry) return;
        const controller = efGetSelectedController();
        const config = efGetIKConfig(controller);
        const target = config && efFindNodeByUuid(config.target);
        if (!config || !(target instanceof ArmatureBone)) {
            ikLineGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
            ikLineHelper.visible = false;
            return;
        }
        const bones = efCollectIKChain(target, config.chain_length);
        const points = [];
        bones.forEach((bone, index) => {
            const start = efGetNodeWorldPosition(bone);
            const end = bones[index + 1]
                ? efGetNodeWorldPosition(bones[index + 1])
                : efGetIKEffectorWorldPosition(target);
            points.push(start.x, start.y, start.z, end.x, end.y, end.z);
        });
        const effector = efGetIKEffectorWorldPosition(target);
        const targetPosition = efGetNodeWorldPosition(controller);
        points.push(effector.x, effector.y, effector.z, targetPosition.x, targetPosition.y, targetPosition.z);
        const pole = efFindPole(controller);
        if (pole && bones.length > 1) {
            const joint = efGetNodeWorldPosition(bones[bones.length - 1]);
            const polePosition = efGetNodeWorldPosition(pole);
            points.push(joint.x, joint.y, joint.z, polePosition.x, polePosition.y, polePosition.z);
        }
        ikLineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
        ikLineGeometry.computeBoundingSphere();
        ikLineHelper.visible = points.length > 0;
    }

    function efGetControllerParent(chainRoot) {
        return efGetOwningArmature(chainRoot) || 'root';
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
                enabled: false,
                limitation: new THREE.Vector3(1, 0, 0),
                rotationMin: new THREE.Vector3(-Math.PI, -Math.PI, -Math.PI),
                rotationMax: new THREE.Vector3(Math.PI, Math.PI, Math.PI)
            };
        }
        // 大腿/上臂：球关节，限制外展/内收
        if (/thigh|upper_arm|arm_upper/.test(name)) {
            return {
                enabled: false,
                rotationMin: new THREE.Vector3(-Math.PI, -Math.PI, -Math.PI),
                rotationMax: new THREE.Vector3(Math.PI, Math.PI, Math.PI)
            };
        }
        return null;
    }

    function efCreateController(targetBone, chainLength, options) {
        const chainBones = efCollectIKChain(targetBone, chainLength);
        if (!chainBones.length) return null;

        const settings = options || {};
        const created = settings.created || [];
        if (!settings.created) Undo.initEdit({elements: created, outliner: true});

        const parent = settings.parent || efGetControllerParent(chainBones[0]);
        const controller = new NullObject().addTo(parent).init();
        controller.name = targetBone.name + '_ik';
        controller.ik_target = targetBone.uuid;
        controller.ik_source = chainBones[0].uuid;
        controller.ef_ik = {
            version: 2,
            role: 'target',
            target: targetBone.uuid,
            chain_length: Math.max(0, Math.floor(Number(chainLength) || 0)),
            enabled: true,
            influence: 1,
            pole: '',
            pole_angle: 0,
            twist_stiffness: 0.75,
            iterations: 10,
            pole_iterations: 4,
            tolerance: 0.001,
            limits: {},
            rig: settings.rig || '',
            limb: settings.limb || ''
        };

        chainBones.forEach(bone => {
            const limit = efGetDefaultIKLimit(bone);
            if (limit) controller.ef_ik.limits[bone.uuid] = limit;
        });

        // 控制器放在目标骨骼尾端（ankle/wrist），而不是骨骼中心
        const targetWorld = efGetIKEffectorWorldPosition(targetBone);
        let localPos = targetWorld.clone();
        if (parent !== 'root') {
            parent.mesh.worldToLocal(localPos);
        }
        controller.position[0] = localPos.x;
        controller.position[1] = localPos.y;
        controller.position[2] = localPos.z;
        const targetQuaternion = targetBone.mesh.getWorldQuaternion(new THREE.Quaternion());
        if (parent !== 'root' && parent.mesh) {
            targetQuaternion.premultiply(parent.mesh.getWorldQuaternion(new THREE.Quaternion()).invert());
        }
        const targetEuler = new THREE.Euler().setFromQuaternion(targetQuaternion, Format.euler_order || 'ZYX');
        controller.rotation = [
            Math.radToDeg(targetEuler.x),
            Math.radToDeg(targetEuler.y),
            Math.radToDeg(targetEuler.z)
        ];
        controller.preview_controller.updateTransform(controller);

        // 创建 pole target，默认位置放在 knee/elbow 关节的偏移方向，避免与控制器重叠
        const pole = new NullObject().addTo(parent).init();
        pole.name = targetBone.name + '_ik_pole';
        controller.ef_ik.pole = pole.uuid;
        pole.ef_ik = {
            version: 2,
            role: 'pole',
            controller: controller.uuid,
            rig: settings.rig || '',
            limb: settings.limb || ''
        };

        const helperBone = efFindPoleHelperBone(chainBones[0], targetBone);
        const poleWorld = efComputePoleWorldPosition(chainBones, targetBone, helperBone);
        let poleLocal = poleWorld.clone();
        if (parent !== 'root') {
            parent.mesh.worldToLocal(poleLocal);
        }
        pole.position[0] = poleLocal.x;
        pole.position[1] = poleLocal.y;
        pole.position[2] = poleLocal.z;
        pole.preview_controller.updateTransform(pole);
        controller.preview_controller.updateSelection(controller);
        pole.preview_controller.updateSelection(pole);

        created.push(controller, pole);
        if (!settings.created) {
            Undo.finishEdit(tl('ef.ik.create_undo'));
            Blockbench.showQuickMessage(tl('ef.ik.controller_created'));
        }
        return controller;
    }

    // pole 作为 Thigh FK 控制器：pole 决定大腿方向，小腿再伸向脚踝
    function efGetControllerRotationDelta(controller) {
        const rest = controller.ef_ik && Array.isArray(controller.ef_ik.rest_rotation) ? controller.ef_ik.rest_rotation : [0, 0, 0];
        const restQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.degToRad(rest[0] || 0), Math.degToRad(rest[1] || 0), Math.degToRad(rest[2] || 0), Format.euler_order || 'ZYX'));
        return restQuaternion.invert().multiply(controller.mesh.quaternion.clone());
    }

    function efDisplayFK(source) {
        const sourceTarget = source && source.ef_ik && efFindNodeByUuid(source.ef_ik.target);
        const armature = efGetOwningArmature(sourceTarget);
        const controls = efGetRigControllers(armature);
        const master = controls.find(node => efGetMasterConfig(node));
        const fkByLayer = {};
        controls.forEach(node => {
            const config = efGetFKConfig(node);
            if (config) fkByLayer[config.layer] = node;
        });
        const rootControl = fkByLayer.root;
        if (rootControl) {
            const config = efGetFKConfig(rootControl);
            const target = efFindNodeByUuid(config.target);
            if (target && target.mesh) {
                const restQuaternion = new THREE.Quaternion().fromArray(config.target_rest_quaternion);
                const rotation = restQuaternion.clone();
                if (master) rotation.multiply(efGetControllerRotationDelta(master));
                rotation.multiply(efGetControllerRotationDelta(rootControl));
                target.mesh.quaternion.copy(rotation);
                const restPosition = new THREE.Vector3().fromArray(config.target_rest_position);
                if (master) {
                    const masterConfig = efGetMasterConfig(master);
                    const offset = master.mesh.position.clone().sub(new THREE.Vector3().fromArray(masterConfig.rest_position));
                    restPosition.add(offset);
                }
                target.mesh.position.copy(restPosition);
                target.mesh.updateMatrixWorld(true);
            }
        }
        ['torso', 'chest'].forEach(layer => {
            const control = fkByLayer[layer];
            const config = efGetFKConfig(control);
            const target = config && efFindNodeByUuid(config.target);
            if (!target || !target.mesh) return;
            target.mesh.quaternion.copy(new THREE.Quaternion().fromArray(config.target_rest_quaternion).multiply(efGetControllerRotationDelta(control)));
            target.mesh.position.fromArray(config.target_rest_position);
            target.mesh.updateMatrixWorld(true);
        });
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        if (typeof Animator !== 'undefined' && Animator.displayMeshDeformation) Animator.displayMeshDeformation();
    }

    function efCreateFKController(name, role, target, parent, layer, created) {
        const controller = new NullObject().addTo(parent).init();
        controller.name = name;
        const worldPosition = efGetNodeWorldPosition(target);
        let localPosition = worldPosition.clone();
        if (parent !== 'root' && parent.mesh) parent.mesh.worldToLocal(localPosition);
        controller.position = [localPosition.x, localPosition.y, localPosition.z];
        const targetWorldQuaternion = target.mesh.getWorldQuaternion(new THREE.Quaternion());
        if (parent !== 'root' && parent.mesh) targetWorldQuaternion.premultiply(parent.mesh.getWorldQuaternion(new THREE.Quaternion()).invert());
        const euler = new THREE.Euler().setFromQuaternion(targetWorldQuaternion, Format.euler_order || 'ZYX');
        controller.rotation = [Math.radToDeg(euler.x), Math.radToDeg(euler.y), Math.radToDeg(euler.z)];
        controller.ef_ik = {
            version: 3,
            role,
            rig: 'epicfight_humanoid',
            layer,
            target: target.uuid,
            rest_position: controller.position.slice(),
            rest_rotation: controller.rotation.slice(),
            target_rest_position: target.mesh.position.toArray(),
            target_rest_quaternion: target.mesh.quaternion.toArray()
        };
        controller.preview_controller.updateTransform(controller);
        created.push(controller);
        return controller;
    }

    function efRebuildHumanoidRig() {
        const humanoid = efGetHumanoidRig();
        if (!humanoid.valid) return false;
        const existing = [...new Set([...efGetRigControllers(humanoid.armature), ...efGetArmatureIKNodes(humanoid.armature)])];
        const affected = existing.slice();
        Undo.initEdit({elements: affected, outliner: true});
        existing.forEach(node => node.remove());
        const parent = efGetControllerParent(humanoid.bones.Root);
        efCreateFKController('Master', 'master', humanoid.bones.Root, parent, 'master', affected);
        efCreateFKController('Root_FK', 'fk', humanoid.bones.Root, parent, 'root', affected);
        efCreateFKController('Torso_FK', 'fk', humanoid.bones.Torso, parent, 'torso', affected);
        efCreateFKController('Chest_FK', 'fk', humanoid.bones.Chest, parent, 'chest', affected);
        [['Leg_R', 'leg_r'], ['Leg_L', 'leg_l'], ['Tool_R', 'arm_r'], ['Tool_L', 'arm_l']].forEach(item => {
            efCreateController(humanoid.bones[item[0]], 2, {created: affected, parent, rig: 'epicfight_humanoid', limb: item[1]});
        });
        Undo.finishEdit(tl('ef.rig.rebuild_undo'));
        Animator.preview();
        Blockbench.showQuickMessage(tl('ef.rig.rebuilt'));
        return true;
    }

    function efApplyTargetOrientation(controller, target, get_samples, results) {
        if (target instanceof ArmatureBone && /^Tool_[RL]$/i.test(target.name)) return results;
        if (!controller || !controller.mesh || !target || !target.mesh || !target.mesh.parent) return results;
        const config = efGetIKConfig(controller);
        const influence = THREE.MathUtils.clamp(config && config.influence === undefined ? 1 : Number(config && config.influence), 0, 1);
        const controllerWorldQuaternion = controller.mesh.getWorldQuaternion(new THREE.Quaternion());
        const parentWorldQuaternion = target.mesh.parent.getWorldQuaternion(new THREE.Quaternion());
        const targetLocalQuaternion = parentWorldQuaternion.invert().multiply(controllerWorldQuaternion);
        target.mesh.quaternion.slerp(targetLocalQuaternion, influence);
        target.mesh.rotation.setFromQuaternion(target.mesh.quaternion, Format.euler_order || 'ZYX');
        target.mesh.updateMatrixWorld(true);
        if (get_samples) {
            const restRotation = target.mesh.fix_rotation
                ? target.mesh.fix_rotation.clone()
                : new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
            restRotation.order = Format.euler_order || restRotation.order;
            const restQuaternion = new THREE.Quaternion().setFromEuler(restRotation);
            const deltaQuaternion = restQuaternion.invert().multiply(target.mesh.quaternion);
            const deltaEuler = new THREE.Euler().setFromQuaternion(deltaQuaternion, Format.euler_order || 'ZYX');
            if (!results) results = {};
            results[target.uuid] = {
                euler: deltaEuler,
                array: efMakeEulerContinuous(controller, target, [
                    Math.radToDeg(deltaEuler.x),
                    Math.radToDeg(deltaEuler.y),
                    Math.radToDeg(deltaEuler.z)
                ])
            };
        }
        return results;
    }

    function efSolveFKPoleIK(bones, target, controller, pole, boneWorldPositions, get_samples) {
        if (bones.length !== 2) return null;
        const config = efGetIKConfig(controller);
        if (!config) return null;

        const hipWorld = boneWorldPositions[0].start.clone();
        const kneeRest = boneWorldPositions[0].end.clone();
        const ankleTarget = efGetNodeWorldPosition(controller);
        const poleWorld = efGetNodeWorldPosition(pole);
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
            const targetWorldQuat = deltaQuat.multiply(boneWorldPositions[i].quaternion);
            const parentQuat = bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion());
            let newLocalQuat = parentQuat.clone().invert().multiply(targetWorldQuat);
            const fixRotation = bone.mesh.fix_rotation
                ? bone.mesh.fix_rotation.clone()
                : new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
            fixRotation.order = Format.euler_order || fixRotation.order;
            const fixQuat = new THREE.Quaternion().setFromEuler(fixRotation);
            newLocalQuat = efApplyTwistStiffness(newLocalQuat, fixQuat, Number(config.twist_stiffness) || 0);
            newLocalQuat = efApplyIKLimit(newLocalQuat, fixQuat, config.limits && config.limits[bone.uuid]);
            const influencedQuat = fixQuat.clone().slerp(
                newLocalQuat,
                THREE.MathUtils.clamp(config.influence === undefined ? 1 : Number(config.influence), 0, 1)
            );
            bone.mesh.quaternion.copy(influencedQuat);
            bone.mesh.rotation.setFromQuaternion(influencedQuat, Format.euler_order || 'ZYX');
            bone.mesh.updateMatrixWorld(true);

            if (get_samples) {
                const appliedLocalQuat = influencedQuat.clone();
                const appliedDeltaQuat = fixQuat.clone().invert().multiply(appliedLocalQuat);
                const deltaEuler = new THREE.Euler().setFromQuaternion(appliedDeltaQuat, Format.euler_order || 'ZYX');
                results[bone.uuid] = {
                    euler: deltaEuler,
                    array: efMakeEulerContinuous(controller, bone, [
                        Math.radToDeg(deltaEuler.x),
                        Math.radToDeg(deltaEuler.y),
                        Math.radToDeg(deltaEuler.z),
                    ])
                };
            }
        });

        return get_samples ? results : undefined;
    }

    function efSolveSingleBoneIK(bones, controller, boneWorldPositions, get_samples) {
        const config = efGetIKConfig(controller);
        if (!config || bones.length !== 1) return null;
        const bone = bones[0];
        const rest = boneWorldPositions[0];
        const restDirection = rest.end.clone().sub(rest.start);
        const targetDirection = efGetNodeWorldPosition(controller).sub(rest.start);
        if (restDirection.lengthSq() < 1e-12 || targetDirection.lengthSq() < 1e-12) return null;
        restDirection.normalize();
        targetDirection.normalize();
        const targetWorldQuaternion = new THREE.Quaternion().setFromUnitVectors(restDirection, targetDirection).multiply(rest.quaternion);
        const parentQuaternion = bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion());
        const restRotation = bone.mesh.fix_rotation
            ? bone.mesh.fix_rotation.clone()
            : new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
        restRotation.order = Format.euler_order || restRotation.order;
        const restQuaternion = new THREE.Quaternion().setFromEuler(restRotation);
        let localQuaternion = parentQuaternion.invert().multiply(targetWorldQuaternion);
        localQuaternion = efApplyTwistStiffness(localQuaternion, restQuaternion, Number(config.twist_stiffness) || 0);
        localQuaternion = efApplyIKLimit(localQuaternion, restQuaternion, config.limits && config.limits[bone.uuid]);
        localQuaternion = restQuaternion.clone().slerp(localQuaternion, THREE.MathUtils.clamp(config.influence === undefined ? 1 : Number(config.influence), 0, 1));
        bone.mesh.quaternion.copy(localQuaternion);
        bone.mesh.updateMatrixWorld(true);
        if (!get_samples) return undefined;
        const deltaQuaternion = restQuaternion.clone().invert().multiply(localQuaternion);
        const deltaEuler = new THREE.Euler().setFromQuaternion(deltaQuaternion, Format.euler_order || 'ZYX');
        return {
            [bone.uuid]: {
                euler: deltaEuler,
                array: efMakeEulerContinuous(controller, bone, [
                    Math.radToDeg(deltaEuler.x),
                    Math.radToDeg(deltaEuler.y),
                    Math.radToDeg(deltaEuler.z)
                ])
            }
        };
    }

    function efSolveTwoBoneIKWithPole(bones, target, controller, pole, boneWorldPositions, get_samples) {
        const config = efGetIKConfig(controller);
        if (!config) return null;
        const hipWorld = boneWorldPositions[0].start;
        const kneeRest = boneWorldPositions[0].end;
        const ankleRest = boneWorldPositions[1].end;
        const thighLen = hipWorld.distanceTo(kneeRest);
        const legLen = kneeRest.distanceTo(ankleRest);
        const ankleTarget = efGetNodeWorldPosition(controller);
        const poleWorld = efGetNodeWorldPosition(pole);
        const targetOffset = ankleTarget.clone().sub(hipWorld);
        if (targetOffset.lengthSq() < 1e-12 || thighLen < 1e-6 || legLen < 1e-6) return null;
        const axis = targetOffset.normalize();
        const minReach = Math.abs(thighLen - legLen) + 1e-5;
        const maxReach = Math.max(minReach, thighLen + legLen - 1e-5);
        const dist = THREE.MathUtils.clamp(hipWorld.distanceTo(ankleTarget), minReach, maxReach);
        const solvedTarget = hipWorld.clone().add(axis.clone().multiplyScalar(dist));
        const d1 = (thighLen * thighLen - legLen * legLen + dist * dist) / (2 * dist);
        const r = Math.sqrt(Math.max(0, thighLen * thighLen - d1 * d1));
        const circleCenter = hipWorld.clone().add(axis.clone().multiplyScalar(d1));

        const poleToCenter = poleWorld.clone().sub(circleCenter);
        let poleProj = poleToCenter.clone().sub(axis.clone().multiplyScalar(poleToCenter.dot(axis)));
        if (poleProj.lengthSq() < 1e-6) {
            const restJointOffset = kneeRest.clone().sub(circleCenter);
            poleProj = restJointOffset.sub(axis.clone().multiplyScalar(restJointOffset.dot(axis)));
        }
        if (poleProj.lengthSq() < 1e-6) {
            const arbitrary = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
            poleProj = new THREE.Vector3().crossVectors(axis, arbitrary);
        }
        poleProj.normalize();
        const poleAngle = Math.degToRad(Number(config.pole_angle) || 0);
        if (Math.abs(poleAngle) > 1e-8) poleProj.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, poleAngle));
        const kneeWorld = circleCenter.clone().add(poleProj.multiplyScalar(r));

        const fikBones = [
            { start: hipWorld, end: kneeWorld },
            { start: kneeWorld, end: solvedTarget }
        ];

        const results = {};
        bones.forEach((bone, i) => {
            const restWorld = boneWorldPositions[i].end.clone().sub(boneWorldPositions[i].start).normalize();
            const ikWorld = fikBones[i].end.clone().sub(fikBones[i].start).normalize();

            const deltaQuat = new THREE.Quaternion().setFromUnitVectors(restWorld, ikWorld);
            const targetWorldQuat = deltaQuat.multiply(boneWorldPositions[i].quaternion);
            const parentQuat = bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion());
            let newLocalQuat = parentQuat.clone().invert().multiply(targetWorldQuat);
            const fixRotation = bone.mesh.fix_rotation
                ? bone.mesh.fix_rotation.clone()
                : new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
            fixRotation.order = Format.euler_order || fixRotation.order;
            const fixQuat = new THREE.Quaternion().setFromEuler(fixRotation);
            newLocalQuat = efApplyTwistStiffness(newLocalQuat, fixQuat, Number(config.twist_stiffness) || 0);
            newLocalQuat = efApplyIKLimit(newLocalQuat, fixQuat, config.limits && config.limits[bone.uuid]);
            const influencedQuat = fixQuat.clone().slerp(
                newLocalQuat,
                THREE.MathUtils.clamp(config.influence === undefined ? 1 : Number(config.influence), 0, 1)
            );
            bone.mesh.quaternion.copy(influencedQuat);
            bone.mesh.rotation.setFromQuaternion(influencedQuat, Format.euler_order || 'ZYX');
            bone.mesh.updateMatrixWorld(true);

            if (get_samples) {
                const appliedLocalQuat = influencedQuat.clone();
                const appliedDeltaQuat = fixQuat.clone().invert().multiply(appliedLocalQuat);
                const deltaEuler = new THREE.Euler().setFromQuaternion(appliedDeltaQuat, Format.euler_order || 'ZYX');
                results[bone.uuid] = {
                    euler: deltaEuler,
                    array: efMakeEulerContinuous(controller, bone, [
                        Math.radToDeg(deltaEuler.x),
                        Math.radToDeg(deltaEuler.y),
                        Math.radToDeg(deltaEuler.z),
                    ])
                };
            }
        });

        return get_samples ? results : undefined;
    }

    // 自定义 IK 求解，修复 Blockbench 原生 displayIK 对旋转骨骼 rest direction 的计算错误
    function efDisplayIK(animator, get_samples) {
        const null_object = animator.getElement();
        const config = efGetIKConfig(null_object);
        if (!config) return;

        const target = efFindNodeByUuid(config.target);
        if (!(target instanceof ArmatureBone)) return;

        if (config.enabled === false) {
            const ankleWorld = efGetIKEffectorWorldPosition(target);
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

        const bones = efCollectIKChain(target, config.chain_length);
        if (!bones.length) return;

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
            const end = next
                ? next.mesh.getWorldPosition(new THREE.Vector3())
                : efUsesBoneOriginAsEffector(target)
                    ? efGetNodeWorldPosition(target)
                    : efGetBoneTailWorldPosition(bone);
            const quaternion = bone.mesh.getWorldQuaternion(new THREE.Quaternion());
            boneWorldPositions.push({ start, end, quaternion });
        });

        const pole = efFindPole(null_object);

        if (bones.length === 1) {
            let result = efSolveSingleBoneIK(bones, null_object, boneWorldPositions, get_samples);
            if (result !== null) {
                if (!bones.includes(target)) result = efApplyTargetOrientation(null_object, target, get_samples, result);
                if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
                if (typeof Animator !== 'undefined' && Animator.displayMeshDeformation) Animator.displayMeshDeformation();
                return result;
            }
        }

        if (bones.length === 2 && pole) {
            let result = efSolveTwoBoneIKWithPole(bones, target, null_object, pole, boneWorldPositions, get_samples);
            if (result !== null) {
                bones.forEach(efApplyBoneAnimationRotation);
                if (get_samples) result = efCollectIKSamples(bones, null_object);
                if (!bones.includes(target)) result = efApplyTargetOrientation(null_object, target, get_samples, result);
                if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
                if (typeof Animator !== 'undefined' && Animator.displayMeshDeformation) Animator.displayMeshDeformation();
                return result;
            }
        }

        // 使用 Three.js CCDIKSolver 求解
        // 在目标骨骼尾端创建一个临时 effector bone，这样 Leg 和 Thigh 都能被旋转
        const effectorBone = new THREE.Bone();
        effectorBone.name = target.name + '_ik_effector';
        const tailWorld = efGetIKEffectorWorldPosition(target);
        const tailLocal = tailWorld.clone();
        target.mesh.worldToLocal(tailLocal);
        effectorBone.position.copy(tailLocal);
        target.mesh.add(effectorBone);
        effectorBone.updateMatrixWorld();

        try {
            const ikBones = bones.map(bone => bone.mesh);
            const effectorIndex = bones.length;
            ikBones.push(effectorBone);
            ikBones.push(null_object.mesh);
            const targetIndex = ikBones.length - 1;

            const links = [];
            for (let i = effectorIndex - 1; i >= 0; i--) {
                const bone = bones[i];
                const limit = config.limits && config.limits[bone.uuid];
                const link = { index: i, enabled: true };
                if (limit && limit.enabled) {
                    if (limit.limitation) link.limitation = efToVector3(limit.limitation);
                    // IK 限制值表示相对于 rest pose 的偏移，转换为绝对限制传入 solver
                    const fixRot = bone.mesh.fix_rotation || new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
                    if (limit.rotationMin) {
                        const rotationMin = efToVector3(limit.rotationMin);
                        link.rotationMin = new THREE.Vector3(
                            fixRot.x + rotationMin.x,
                            fixRot.y + rotationMin.y,
                            fixRot.z + rotationMin.z
                        );
                    }
                    if (limit.rotationMax) {
                        const rotationMax = efToVector3(limit.rotationMax);
                        link.rotationMax = new THREE.Vector3(
                            fixRot.x + rotationMax.x,
                            fixRot.y + rotationMax.y,
                            fixRot.z + rotationMax.z
                        );
                    }
                }
                links.push(link);
            }

            const ik = {
                effector: effectorIndex,
                target: targetIndex,
                links: links,
                iteration: THREE.MathUtils.clamp(Math.floor(Number(config.iterations) || 10), 1, 100),
                blendFactor: THREE.MathUtils.clamp(config.influence === undefined ? 1 : Number(config.influence), 0, 1),
                tolerance: Math.max(1e-6, Number(config.tolerance) || 0.001),
            };

            const skinnedMesh = { skeleton: { bones: ikBones } };
            const solver = new CCDIKSolver(skinnedMesh, [ik]);
            solver.update();
            if (pole && bones.length > 2) {
                const poleWorld = efGetNodeWorldPosition(pole);
                const rootWorld = bones[0].mesh.getWorldPosition(new THREE.Vector3());
                const effectorWorld = efGetIKEffectorWorldPosition(target);
                const chainAxis = effectorWorld.clone().sub(rootWorld);
                const tolerance = Math.max(1e-6, Number(config.tolerance) || 0.001);
                const poleIterations = THREE.MathUtils.clamp(Math.floor(Number(config.pole_iterations) || 4), 1, 50);
                if (chainAxis.lengthSq() > 1e-12) {
                    chainAxis.normalize();
                    const poleAngle = Math.degToRad(Number(config.pole_angle) || 0);
                    for (let pass = 0; pass < poleIterations; pass++) {
                        const poleProjection = poleWorld.clone().sub(rootWorld).projectOnPlane(chainAxis);
                        if (poleProjection.lengthSq() < 1e-12) break;
                        poleProjection.normalize();
                        if (Math.abs(poleAngle) > 1e-8) poleProjection.applyAxisAngle(chainAxis, poleAngle);
                        let corrected = false;
                        for (let jointIndex = 1; jointIndex < bones.length; jointIndex++) {
                            const joint = bones[jointIndex].mesh.getWorldPosition(new THREE.Vector3());
                            const jointProjection = joint.clone().sub(rootWorld).projectOnPlane(chainAxis);
                            if (jointProjection.lengthSq() < 1e-12) continue;
                            jointProjection.normalize();
                            let angle = Math.acos(THREE.MathUtils.clamp(jointProjection.dot(poleProjection), -1, 1));
                            const cross = new THREE.Vector3().crossVectors(jointProjection, poleProjection);
                            if (cross.dot(chainAxis) < 0) angle = -angle;
                            if (Math.abs(angle) <= tolerance) continue;
                            const owner = bones[jointIndex - 1];
                            const parentQuaternion = owner.mesh.parent.getWorldQuaternion(new THREE.Quaternion());
                            const localAxis = chainAxis.clone().applyQuaternion(parentQuaternion.invert());
                            const weight = 1 / (bones.length - jointIndex);
                            owner.mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(localAxis, angle * weight));
                            owner.mesh.updateMatrixWorld(true);
                            corrected = true;
                        }
                        if (!corrected) break;
                        solver.update();
                    }
                }
            }
        } finally {
            target.mesh.remove(effectorBone);
        }

        // CCDIKSolver 直接修改了 bone.mesh.quaternion，同步回 Euler rotation
        bones.forEach(bone => {
            const euler = new THREE.Euler().setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
            bone.mesh.rotation.copy(euler);
            bone.mesh.updateMatrixWorld();
        });

        // 收集结果
        let results = {};
        if (get_samples) {
            bones.forEach(bone => {
                const restRotation = bone.mesh.fix_rotation
                    ? bone.mesh.fix_rotation.clone()
                    : new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
                restRotation.order = Format.euler_order || restRotation.order;
                const restQuat = new THREE.Quaternion().setFromEuler(restRotation);
                const deltaQuat = restQuat.clone().invert().multiply(bone.mesh.quaternion);
                const deltaEuler = new THREE.Euler().setFromQuaternion(deltaQuat, Format.euler_order || 'ZYX');
                results[bone.uuid] = {
                    euler: deltaEuler,
                    array: efMakeEulerContinuous(null_object, bone, [
                        Math.radToDeg(deltaEuler.x),
                        Math.radToDeg(deltaEuler.y),
                        Math.radToDeg(deltaEuler.z),
                    ])
                };
            });
        }

        // 在 IK 结果上叠加骨骼自身旋转关键帧（手动旋转），实现 IK + FK 同时生效
        bones.forEach(efApplyBoneAnimationRotation);
        if (get_samples) results = efCollectIKSamples(bones, null_object);

        if (!bones.includes(target)) results = efApplyTargetOrientation(null_object, target, get_samples, results);

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
        for (const controller of NullObject.all) {
            const config = efGetIKConfig(controller);
            if (!config || config.enabled === false) continue;
            const target = efFindNodeByUuid(config.target);
            if (!target) continue;
            if (efCollectIKChain(target, config.chain_length).includes(bone)) return true;
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
        const config = efGetIKConfig(null_object);
        if (config) return efDisplayIK(this, get_samples);
        const poleConfig = efGetPoleConfig(null_object);
        if (poleConfig) {
            const controller = efFindNodeByUuid(poleConfig.controller);
            if (efGetIKConfig(controller)) {
                const anim = Animation.selected;
                const controllerAnimator = anim ? anim.getBoneAnimator(controller) : null;
                if (controllerAnimator && controllerAnimator.displayIK) controllerAnimator.displayIK(get_samples);
            }
        }
        return origDisplayIK.call(this, get_samples);
    };

    function efValidateHumanoidRig(expectBaked) {
        const humanoid = efGetHumanoidRig();
        const errors = [];
        if (!humanoid.valid) {
            if (humanoid.missing.length) errors.push('Missing: ' + humanoid.missing.join(', '));
            if (humanoid.duplicates.length) errors.push('Duplicate: ' + humanoid.duplicates.join(', '));
            if (humanoid.invalid.length) errors.push('Hierarchy: ' + humanoid.invalid.join(', '));
            return errors;
        }
        const controllers = efGetRigControllers(humanoid.armature);
        if (expectBaked) {
            if (controllers.length) errors.push('Active rig controllers remain after bake');
            if (efGetArmatureIKNodes(humanoid.armature).length) errors.push('Active IK targets remain after bake');
            const animation = Animation.selected;
            Object.keys(humanoid.bones).forEach(name => {
                const animator = animation && animation.animators[humanoid.bones[name].uuid];
                if (!animator || !animator.rotation || !animator.rotation.length) errors.push('No baked rotation: ' + name);
            });
            return errors;
        }
        const roles = controllers.map(node => {
            const config = node.ef_ik;
            return config.role + ':' + (config.layer || config.limb || '');
        });
        ['master:master', 'fk:root', 'fk:torso', 'fk:chest', 'target:leg_r', 'pole:leg_r', 'target:leg_l', 'pole:leg_l', 'target:arm_r', 'pole:arm_r', 'target:arm_l', 'pole:arm_l'].forEach(role => {
            if (!roles.includes(role)) errors.push('Missing controller: ' + role);
        });
        const expectedLimbTargets = {
            leg_r: humanoid.bones.Leg_R,
            leg_l: humanoid.bones.Leg_L,
            arm_r: humanoid.bones.Tool_R,
            arm_l: humanoid.bones.Tool_L
        };
        controllers.forEach(node => {
            const config = node.ef_ik;
            const target = (config.role === 'target' || config.role === 'fk' || config.role === 'master') && efFindNodeByUuid(config.target);
            if ((config.role === 'target' || config.role === 'fk' || config.role === 'master') && !target) errors.push('Broken target: ' + node.name);
            if (config.role === 'target' && expectedLimbTargets[config.limb] && target !== expectedLimbTargets[config.limb]) errors.push('Wrong limb target: ' + node.name);
            const numericValues = [].concat(node.position || [], node.rotation || []);
            if (numericValues.some(value => !Number.isFinite(Number(value)))) errors.push('Invalid transform: ' + node.name);
        });
        return errors;
    }

    function efShowRigValidation(errors, successMessage) {
        if (!errors.length) {
            Blockbench.showQuickMessage(successMessage);
            return true;
        }
        Blockbench.showMessageBox({title: tl('ef.rig.invalid'), icon: 'error', message: errors.join('\n')});
        return false;
    }

    function efBakeHumanoidRig() {
        const animation = Animation.selected;
        const humanoid = efGetHumanoidRig();
        const rigControls = efGetRigControllers(humanoid.armature);
        const controls = [...new Set([...rigControls, ...efGetArmatureIKNodes(humanoid.armature)])];
        if (!animation || !humanoid.valid || !rigControls.length) return false;
        const rate = Math.clamp(Number(animation.snapping) || 20, 1, 144);
        const duration = Math.max(0, Number(animation.length) || 0);
        const previousTime = Timeline.time;
        const states = Animation.all.map(item => ({item, selected: item.selected, playing: item.playing}));
        const timelineAnimators = Timeline.animators ? Timeline.animators.slice() : [];
        const bones = efGetArmatureBones(humanoid.armature);
        const samples = {};
        const previous = {};
        bones.forEach(bone => samples[bone.uuid] = []);
        const times = [];
        for (let step = 0; step <= Math.floor(duration * rate + 0.000001); step++) times.push(Math.min(duration, step / rate));
        if (!times.length || Math.abs(times[times.length - 1] - duration) > 0.000001) times.push(duration);
        let editing = false;
        try {
            Animation.all.forEach(item => {
                item.selected = item === animation;
                item.playing = item === animation;
            });
            Animation.selected = animation;
            if (Timeline.animators) Timeline.animators.length = 0;
            Object.keys(animation.animators || {}).forEach(uuid => animation.animators[uuid].addToTimeline());
            controls.forEach(control => delete control._ef_ik_sample_state);
            times.forEach(time => {
                Timeline.time = time;
                Animator.preview();
                bones.forEach(bone => {
                    const rest = bone.mesh.fix_rotation ? new THREE.Quaternion().setFromEuler(bone.mesh.fix_rotation) : new THREE.Quaternion();
                    const euler = new THREE.Euler().setFromQuaternion(rest.invert().multiply(bone.mesh.quaternion.clone()), Format.euler_order || 'ZYX');
                    const rotation = [Math.radToDeg(euler.x), Math.radToDeg(euler.y), Math.radToDeg(euler.z)];
                    const prior = previous[bone.uuid];
                    if (prior) for (let axis = 0; axis < 3; axis++) {
                        while (rotation[axis] - prior[axis] > 180) rotation[axis] -= 360;
                        while (rotation[axis] - prior[axis] < -180) rotation[axis] += 360;
                    }
                    previous[bone.uuid] = rotation.slice();
                    const restPosition = bone.mesh.fix_position || new THREE.Vector3().fromArray(bone.origin || [0, 0, 0]);
                    samples[bone.uuid].push({time, rotation, position: bone.mesh.position.clone().sub(restPosition).toArray()});
                });
            });
            const removed = [];
            bones.forEach(bone => {
                const animator = animation.animators[bone.uuid];
                if (animator) removed.push(...(animator.rotation || []), ...(animator.position || []));
            });
            Undo.initEdit({keyframes: removed, elements: controls, outliner: true});
            editing = true;
            removed.forEach(keyframe => keyframe.remove());
            const created = [];
            bones.forEach(bone => {
                const animator = animation.getBoneAnimator(bone);
                samples[bone.uuid].forEach(sample => {
                    created.push(animator.createKeyframe({x: sample.rotation[0], y: sample.rotation[1], z: sample.rotation[2]}, sample.time, 'rotation', false, false));
                    created.push(animator.createKeyframe({x: sample.position[0], y: sample.position[1], z: sample.position[2]}, sample.time, 'position', false, false));
                });
                animator.addToTimeline();
            });
            controls.forEach(node => node.remove());
            Undo.finishEdit(tl('ef.rig.bake_undo'), {keyframes: created, elements: controls, outliner: true});
            editing = false;
        } catch (error) {
            if (editing && typeof Undo.cancelEdit === 'function') Undo.cancelEdit(true);
            throw error;
        } finally {
            states.forEach(state => {
                state.item.selected = state.selected;
                state.item.playing = state.playing;
            });
            Animation.selected = (states.find(state => state.selected) || {item: animation}).item;
            if (Timeline.animators) {
                Timeline.animators.length = 0;
                Timeline.animators.push(...timelineAnimators);
            }
            Timeline.time = previousTime;
            Animator.preview();
        }
        return efShowRigValidation(efValidateHumanoidRig(true), tl('ef.rig.baked'));
    }
    const ikActions = [];

    ikActions.push(new Action('ef_rebuild_humanoid_rig', {
        name: tl('ef.rig.rebuild'),
        icon: 'accessibility_new',
        category: 'animation',
        condition: () => Modes.animate && Animation.selected && efGetHumanoidRig().valid,
        searchable: true,
        click: efRebuildHumanoidRig
    }));

    ikActions.push(new Action('ef_bake_humanoid_rig', {
        name: tl('ef.rig.bake'),
        icon: 'cake',
        category: 'animation',
        condition: () => {
            const humanoid = efGetHumanoidRig();
            return Modes.animate && Animation.selected && humanoid.valid && efGetRigControllers(humanoid.armature).length > 0;
        },
        searchable: true,
        click: efBakeHumanoidRig
    }));

    ikActions.push(new Action('ef_validate_humanoid_rig', {
        name: tl('ef.rig.validate'),
        icon: 'verified',
        category: 'animation',
        condition: () => Modes.animate && Animation.selected && !!efGetHumanoidRig().armature,
        searchable: true,
        click() {
            const humanoid = efGetHumanoidRig();
            efShowRigValidation(efValidateHumanoidRig(efGetRigControllers(humanoid.armature).length === 0), tl('ef.rig.valid'));
        }
    }));

    MenuBar.addAction(ikActions[0], 'tools');
    MenuBar.addAction(ikActions[1], 'tools');
    MenuBar.addAction(ikActions[2], 'tools');

    // 创建 IK 控制器
    ikActions.push(new Action('ef_create_ik_controller', {
        name: tl('ef.ik.create_controller'),
        icon: 'fa-link',
        category: 'edit',
        condition: () => Modes.animate && ArmatureBone.selected.length > 0,
        searchable: true,
        click() {
            const targetBone = ArmatureBone.selected[0];
            const maximum = efGetMaximumChainLength(targetBone);
            if (!maximum) return;
            const existing = efFindController(targetBone);
            const existingConfig = efGetIKConfig(existing);
            new Dialog('ef_create_ik_controller_dialog', {
                title: tl('ef.ik.create_controller'),
                form: {
                    chain_length: {
                        type: 'number',
                        label: tl('ef.ik.chain_length'),
                        value: existingConfig ? existingConfig.chain_length : Math.min(2, maximum),
                        min: 0,
                        max: maximum,
                        step: 1
                    }
                },
                onConfirm(result) {
                    const chainLength = THREE.MathUtils.clamp(Math.floor(Number(result.chain_length) || 0), 0, maximum);
                    if (existingConfig) {
                        Undo.initEdit({elements: [existing]});
                        existingConfig.chain_length = chainLength;
                        existing.ef_ik = Object.assign({}, existingConfig);
                        Undo.finishEdit(tl('ef.ik.change_source_undo'));
                    } else {
                        efCreateController(targetBone, chainLength);
                    }
                    Animator.preview();
                }
            }).show();
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
                    const pole = efFindPole(c);
                    if (pole) controllers.push(pole);
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
            const selected = NullObject.selected[0];
            const controller = efResolveController(selected) || ArmatureBone.selected.map(b => efFindController(b)).find(c => c);
            return !!controller;
        },
        click() {
            const selected = NullObject.selected[0];
            const controller = efResolveController(selected) || ArmatureBone.selected.map(b => efFindController(b)).find(c => c);
            const config = efGetIKConfig(controller);
            if (!config) return;
            Undo.initEdit({elements: [controller]});
            config.enabled = config.enabled === false;
            controller.ef_ik = Object.assign({}, config);
            Undo.finishEdit(config.enabled ? tl('ef.ik.enable_undo') : tl('ef.ik.disable_undo'));
            Animator.preview();
            Blockbench.showQuickMessage(config.enabled ? tl('ef.ik.enabled') : tl('ef.ik.disabled'));
        }
    }));

    // 编辑 IK 角度限制
    ikActions.push(new Action('ef_ik_limits', {
        name: tl('ef.ik.limits'),
        icon: 'fa-sliders-h',
        category: 'edit',
        condition() {
            if (!Modes.animate || !Animation.selected) return false;
            const selected = NullObject.selected[0];
            const controller = efResolveController(selected) || ArmatureBone.selected.map(b => efFindController(b)).find(c => c);
            return !!controller;
        },
        click() {
            const selected = NullObject.selected[0];
            const controller = efResolveController(selected) || ArmatureBone.selected.map(b => efFindController(b)).find(c => c);
            const config = efGetIKConfig(controller);
            if (!config) return;

            const target = efFindNodeByUuid(config.target);
            if (!target) return;

            const maximum = efGetMaximumChainLength(target);
            const bones = efCollectIKChain(target, config.chain_length);

            const form = {
                chain_length: {
                    type: 'number',
                    label: tl('ef.ik.chain_length'),
                    value: config.chain_length,
                    min: 0,
                    max: maximum,
                    step: 1
                },
                iterations: {
                    type: 'number',
                    label: tl('ef.ik.iterations'),
                    value: Number(config.iterations) || 10,
                    min: 1,
                    max: 100,
                    step: 1
                },
                pole_iterations: {
                    type: 'number',
                    label: tl('ef.ik.pole_iterations'),
                    value: Number(config.pole_iterations) || 4,
                    min: 1,
                    max: 50,
                    step: 1
                },
                tolerance: {
                    type: 'number',
                    label: tl('ef.ik.tolerance'),
                    value: Number(config.tolerance) || 0.001,
                    min: 0.000001,
                    step: 0.0001
                },
                pole_angle: {
                    type: 'number',
                    label: tl('ef.ik.pole_angle'),
                    value: Number(config.pole_angle) || 0
                },
                influence: {
                    type: 'number',
                    label: tl('ef.ik.influence'),
                    value: config.influence === undefined ? 1 : Number(config.influence),
                    min: 0,
                    max: 1,
                    step: 0.05
                },
                twist_stiffness: {
                    type: 'number',
                    label: tl('ef.ik.twist_stiffness'),
                    value: config.twist_stiffness === undefined ? 0.75 : Number(config.twist_stiffness),
                    min: 0,
                    max: 1,
                    step: 0.05
                }
            };
            bones.forEach(bone => {
                const limit = (config.limits && config.limits[bone.uuid]) || {};
                const defaultLimit = efGetDefaultIKLimit(bone) || {};
                const enabled = !!limit.enabled;
                const limitation = limit.limitation
                    ? efToVector3(limit.limitation)
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
                const savedMin = limit.rotationMin ? efToVector3(limit.rotationMin) : null;
                const savedMax = limit.rotationMax ? efToVector3(limit.rotationMax) : null;
                const minDeg = savedMin
                    ? [Math.radToDeg(savedMin.x), Math.radToDeg(savedMin.y), Math.radToDeg(savedMin.z)]
                    : defaultMin;
                const maxDeg = savedMax
                    ? [Math.radToDeg(savedMax.x), Math.radToDeg(savedMax.y), Math.radToDeg(savedMax.z)]
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
                    config.chain_length = THREE.MathUtils.clamp(Math.floor(Number(result.chain_length) || 0), 0, maximum);
                    config.iterations = THREE.MathUtils.clamp(Math.floor(Number(result.iterations) || 10), 1, 100);
                    config.pole_iterations = THREE.MathUtils.clamp(Math.floor(Number(result.pole_iterations) || 4), 1, 50);
                    config.tolerance = Math.max(0.000001, Number(result.tolerance) || 0.001);
                    config.pole_angle = Number(result.pole_angle) || 0;
                    config.influence = THREE.MathUtils.clamp(Number(result.influence), 0, 1);
                    config.twist_stiffness = THREE.MathUtils.clamp(Number(result.twist_stiffness), 0, 1);
                    config.limits = {};
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
                        config.limits[bone.uuid] = {
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
                    controller.ef_ik = Object.assign({}, config);
                    Undo.finishEdit(tl('ef.ik.edit_limits_undo'));
                    Animator.preview();
                }
            }).show();
        }
    }));

    function efAddIKMenuItems(menu, items) {
        if (!menu || !Array.isArray(menu.structure) || patchedIKMenus.has(menu)) return;
        const entries = [new MenuSeparator('ef_ik'), ...items];
        menu.structure.push(...entries);
        patchedIKMenus.set(menu, entries);
    }

    const origShowContextMenu = ArmatureBone.prototype.showContextMenu;
    ArmatureBone.prototype.showContextMenu = function(event) {
        efAddIKMenuItems(this.menu, [
            'ef_rebuild_humanoid_rig',
            'ef_bake_humanoid_rig',
            'ef_validate_humanoid_rig',
            new MenuSeparator('ef_ik_manual'),
            'ef_create_ik_controller',
            'ef_break_ik_controller',
            'ef_bake_ik_controller',
            'ef_toggle_ik_controller',
            'ef_ik_limits'
        ]);
        return origShowContextMenu.call(this, event);
    };

    const origNullShowContextMenu = NullObject.prototype.showContextMenu;
    NullObject.prototype.showContextMenu = function(event) {
        efAddIKMenuItems(this.menu, [
            'ef_toggle_ik_controller',
            'ef_ik_limits'
        ]);
        return origNullShowContextMenu.call(this, event);
    };

    return {
        cleanup() {
            NullObjectAnimator.prototype.displayIK = origDisplayIK;
            NullObjectAnimator.prototype.displayFrame = originalNullDisplayFrame;
            NullObjectAnimator.prototype.channels = originalNullChannels;
            BoneAnimator.prototype.displayRotation = origDisplayRotation;
            NullObject.preview_controller.updateTransform = originalNullUpdateTransform;
            NullObject.preview_controller.updateSelection = originalNullUpdateSelection;
            if (originalPreviewRaycast) Preview.prototype.raycast = originalPreviewRaycast;
            NullObject.prototype.constructor.behavior.rotatable = originalNullObjectRotatable;
            ArmatureBone.prototype.showContextMenu = origShowContextMenu;
            NullObject.prototype.showContextMenu = origNullShowContextMenu;
            patchedIKMenus.forEach((entries, menu) => {
                entries.forEach(entry => {
                    const index = menu.structure.indexOf(entry);
                    if (index !== -1) menu.structure.splice(index, 1);
                });
            });
            patchedIKMenus.clear();
            Blockbench.removeListener('update_selection', updateIKVisuals);
            Blockbench.removeListener('update_view', updateIKVisuals);
            if (ikLineHelper.parent) ikLineHelper.parent.remove(ikLineHelper);
            ikLineGeometry.dispose();
            ikLineMaterial.dispose();
            NullObject.all.forEach(element => {
                delete element._ef_ik_sample_state;
                if (element.mesh) {
                    efDisposeControllerVisual(controllerVisuals.get(element.uuid));
                    if (element.ef_ik) {
                        originalNullUpdateTransform.call(NullObject.preview_controller, element);
                        originalNullUpdateSelection.call(NullObject.preview_controller, element);
                    }
                }
            });
            [...controllerVisuals.values()].forEach(efDisposeControllerVisual);
            controllerVisuals.clear();
            ikActions.forEach(a => a.delete());
            ikProperties.forEach(property => property.delete());
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
