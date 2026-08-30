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
    const normals = vertices.normals && Array.isArray(vertices.normals.array)
        ? vertices.normals.array.map(value => Number(value) || 0)
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

    // EF parts 的数组是逐 loop 的 (position, uv, normal) 三元组。按 part 建立
    // Blockbench Mesh，避免合并后丢失面的 part 归属；位置可共享，但 UV/normal 索引不可按位置复用。
    const meshes = [];

    for (const [partName, partData] of Object.entries(parts)) {
        if (!partData || !Array.isArray(partData.array) || partData.array.length < 9) continue;

        const localVertexMap = {};
        const localPositions = [];
        const localPolygons = [];
        const localVertexWeights = {};

        function ensureLocalVertex(globalIndex) {
            if (localVertexMap[globalIndex] !== undefined) return localVertexMap[globalIndex];
            const corrected = correctedPositions[globalIndex];
            if (!corrected) throw new Error('Mesh references invalid position index: ' + globalIndex);
            const localIndex = localPositions.length / 3;
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

        const array = partData.array;
        const triangleCount = Math.floor(array.length / 9);
        for (let triIndex = 0; triIndex < triangleCount; triIndex++) {
            const base = triIndex * 9;
            const faceVertices = [];
            const faceUvs = [];
            const faceNormals = [];
            for (let corner = 0; corner < 3; corner++) {
                const loopBase = base + corner * 3;
                const positionIndex = Math.floor(Number(array[loopBase]) || 0);
                const uvIndex = Math.floor(Number(array[loopBase + 1]) || 0);
                const normalIndex = Math.floor(Number(array[loopBase + 2]) || 0);
                faceVertices.push(ensureLocalVertex(positionIndex));
                const u = uvs[uvIndex * 2];
                const v = uvs[uvIndex * 2 + 1];
                // 官方 Blender exporter 写出 (u, 1-v_blender)，所以 EF V=0 在顶部。
                // 暂存归一化值，创建 MeshFace 并解析其实际 texture 后再转 Blockbench UV 单位。
                faceUvs.push([
                    roundNumber(u === undefined ? 0 : (Number(u) || 0), 6),
                    roundNumber(v === undefined ? 0 : (Number(v) || 0), 6)
                ]);
                faceNormals.push([
                    normals[normalIndex * 3] || 0,
                    normals[normalIndex * 3 + 1] || 0,
                    normals[normalIndex * 3 + 2] || 0
                ]);
            }
            localPolygons.push({
                vertices: faceVertices,
                uvs: faceUvs,
                normals: faceNormals,
                normalizedUvs: true
            });
        }

        if (localPolygons.length) {
            meshes.push({
                name: fileName + '_' + partName + '_Mesh',
                partName: partName,
                positions: localPositions,
                polygons: localPolygons,
                vertexWeights: localVertexWeights
            });
        }
    }

    if (!meshes.length) throw new Error('EpicFight mesh JSON contains no importable parts.');
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
        // Preserve the EF part independently from the Blockbench parent hierarchy.
        mesh._efPartName = geo.partName || 'noGroups';
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
            // Keep the imported EF part on each face so later merge/split operations
            // can preserve part ownership even when the Mesh is reused.
            face._efPartName = geo.partName || mesh._efPartName || 'noGroups';
            if (polygon.normalizedUvs) {
                const texture = typeof face.getTexture === 'function' ? face.getTexture() : null;
                const texW = texture && typeof texture.getUVWidth === 'function'
                    ? texture.getUVWidth() : ((typeof Project !== 'undefined' && Project.texture_width) || 16);
                const texH = texture && typeof texture.getUVHeight === 'function'
                    ? texture.getUVHeight() : ((typeof Project !== 'undefined' && Project.texture_height) || 16);
                for (const key of faceKeys) {
                    face.uv[key][0] = roundNumber(face.uv[key][0] * texW, 6);
                    face.uv[key][1] = roundNumber(face.uv[key][1] * texH, 6);
                }
            }
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
    if (element && element._efPartName) return element._efPartName;
    let parent = element && element.parent;
    while (parent) {
        if (parent instanceof Group) {
            return parent.name;
        }
        parent = parent.parent;
    }
    return 'noGroups';
}

function getPartNameForMeshFace(face, element) {
    if (face && face._efPartName) return face._efPartName;
    if (element && element._efPartName) return element._efPartName;
    return getPartNameForElement(element);
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

// Must match CubeFace.getVertexIndices() and THREE.BoxGeometry's four UV slots.
var CUBE_FACE_DEFS = {
    north: { corners: [1, 4, 6, 3] },
    east:  { corners: [0, 1, 3, 2] },
    south: { corners: [5, 0, 2, 7] },
    west:  { corners: [4, 5, 7, 6] },
    up:    { corners: [4, 1, 0, 5] },
    down:  { corners: [7, 2, 3, 6] }
};

function getCubeCorners(cube) {
    var from = cube.from;
    var to = cube.to;
    // 索引与应用对象变换前的 Cube.getGlobalVertexPositions() 一致。
    var corners = [
        [to[0],   to[1],   to[2]],
        [to[0],   to[1],   from[2]],
        [to[0],   from[1], to[2]],
        [to[0],   from[1], from[2]],
        [from[0], to[1],   from[2]],
        [from[0], to[1],   to[2]],
        [from[0], from[1], from[2]],
        [from[0], from[1], to[2]]
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
    if (typeof face.getSortedVertices === 'function') return face.getSortedVertices();
    return face.vertices || [];
}

function getFaceUVSize(face) {
    const texture = face && typeof face.getTexture === 'function' ? face.getTexture() : null;
    return [
        texture && typeof texture.getUVWidth === 'function'
            ? texture.getUVWidth() : ((typeof Project !== 'undefined' && Project.texture_width) || 16),
        texture && typeof texture.getUVHeight === 'function'
            ? texture.getUVHeight() : ((typeof Project !== 'undefined' && Project.texture_height) || 16)
    ];
}

function getCubeFaceCornerUVs(face) {
    const uv = face && face.uv && face.uv.length >= 4 ? face.uv : [0, 0, 0, 0];
    let result = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[0], uv[3]], [uv[2], uv[3]]];
    let rotation = ((Number(face && face.rotation) || 0) % 360 + 360) % 360;
    while (rotation > 0) {
        result = [result[2], result[0], result[3], result[1]];
        rotation -= 90;
    }
    return result;
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
                if (!faceObj || faceObj.texture === null || faceObj.enabled === false) continue;
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

                var efNormal = convertBlockbenchNormalToEF(computeFaceNormal(v0, v2, v1));
                var normalKey = vec3Key(efNormal).join(',');
                var normalIdx = normalMap[normalKey];
                if (normalIdx === undefined) {
                    normalIdx = nextNormalIdx++;
                    normalMap[normalKey] = normalIdx;
                    normalList.push(efNormal[0], efNormal[1], efNormal[2]);
                }

                const faceUVSize = getFaceUVSize(faceObj);
                const cornerUVs = getCubeFaceCornerUVs(faceObj);
                // Blockbench 的四个 UV 槽按 BoxGeometry 顺序排列，face.rotation 每 90°
                // 轮换一次槽位。EF 与 Blockbench 都是顶部原点 V，故只按面的纹理尺寸归一化。
                var uv0 = [cornerUVs[0][0] / faceUVSize[0], cornerUVs[0][1] / faceUVSize[1]];
                var uv1 = [cornerUVs[1][0] / faceUVSize[0], cornerUVs[1][1] / faceUVSize[1]];
                var uv2 = [cornerUVs[2][0] / faceUVSize[0], cornerUVs[2][1] / faceUVSize[1]];
                var uv3 = [cornerUVs[3][0] / faceUVSize[0], cornerUVs[3][1] / faceUVSize[1]];

                var uvIdx0 = getOrCreateUvIdx(uv0);
                var uvIdx1 = getOrCreateUvIdx(uv1);
                var uvIdx2 = getOrCreateUvIdx(uv2);
                var uvIdx3 = getOrCreateUvIdx(uv3);

                // THREE.BoxGeometry / Blockbench cube winding: 0,2,1 and 2,3,1.
                pushTriangleToParts(currentPart, vIdx0, uvIdx0, normalIdx);
                pushTriangleToParts(currentPart, vIdx2, uvIdx2, normalIdx);
                pushTriangleToParts(currentPart, vIdx1, uvIdx1, normalIdx);

                pushTriangleToParts(currentPart, vIdx2, uvIdx2, normalIdx);
                pushTriangleToParts(currentPart, vIdx3, uvIdx3, normalIdx);
                pushTriangleToParts(currentPart, vIdx1, uvIdx1, normalIdx);

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
            const facePart = getPartNameForMeshFace(face, element);
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

                const faceUVSize = getFaceUVSize(face);

                for (const vkey of tri) {
                    const vi = vkeyToIdx[vkey];
                    const rawUv = (face.uv && face.uv[vkey]) ? face.uv[vkey] : [0, 0];
                    // MeshFace UV 也是顶部原点；必须使用该面的 texture UV 尺寸。
                    const normU = rawUv[0] / faceUVSize[0];
                    const normV = rawUv[1] / faceUVSize[1];
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

                    pushTriangleToParts(facePart, vi, uvIdx, normalIdx);
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
        'ef.ik.chain_length.desc': 'Each selected bone is clamped to its own maximum chain length.',
        'ef.ik.create_pole': 'Create Pole Target',
        'ef.ik.create_pole.desc': 'Create a pole target for each newly created controller.',
        'ef.ik.controllers_created': 'IK controllers processed: %s',
        'ef.ik.create_batch_undo': 'Create IK controllers',
        'ef.ik.influence': 'IK Influence',
        'ef.ik.iterations': 'CCD Iterations',
        'ef.ik.pole_iterations': 'Pole Convergence Passes',
        'ef.ik.tolerance': 'Convergence Tolerance',
        'ef.ik.pole_angle': 'Pole Angle (deg)',
        'ef.ik.twist_stiffness': 'Twist Stiffness',
        'ef.ik.bake_title': 'Bake Action',
        'ef.ik.frame_start': 'Start Frame',
        'ef.ik.frame_end': 'End Frame',
        'ef.ik.frame_step': 'Frame Step',
        'ef.ik.only_selected': 'Only Selected Bones',
        'ef.ik.visual_keying': 'Visual Keying',
        'ef.ik.clear_constraints': 'Clear Constraints',
        'ef.ik.clear_parents': 'Clear Parents',
        'ef.ik.bake_data': 'Bake Data',
        'ef.ik.pose': 'Pose',
        'ef.ik.object': 'Object',
        'ef.ik.overwrite': 'Overwrite Current Action',
        'ef.ik.clean_curves': 'Clean Curves',
        'ef.ik.bake_undo': 'Bake IK action',
        'ef.ik.baked': 'IK action baked',
        'ef.ik.nothing_to_bake': 'No bones match the bake options',
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
        'ef.rig.bake_undo': 'Bake humanoid IK/FK rig',
        'ef.constraint.panel': 'Constraints',
        'ef.constraint.select_bone': 'Select an armature bone to edit constraints',
        'ef.constraint.copy_transform': 'Copy Transform',
        'ef.constraint.copy_position': 'Copy Position',
        'ef.constraint.position_blend': 'Position Blend',
        'ef.constraint.copy_rotation': 'Copy Rotation',
        'ef.constraint.copy_quaternion': 'Copy Quaternion',
        'ef.constraint.rotation_blend': 'Rotation Blend',
        'ef.constraint.scale_blend': 'Scale Blend',
        'ef.constraint.rotation_difference': 'Rotation Difference',
        'ef.constraint.distance': 'Distance',
        'ef.constraint.limit_distance': 'Limit Distance',
        'ef.constraint.distance_mode': 'Mode',
        'ef.constraint.distance_mode_exact': 'Exact',
        'ef.constraint.distance_mode_minimum': 'Minimum',
        'ef.constraint.distance_mode_maximum': 'Maximum',
        'ef.constraint.distance_mode_initial': 'Initial',
        'ef.constraint.distance_value': 'Distance',
        'ef.constraint.initial_distance': 'Initial Distance',
        'ef.constraint.reset_initial_distance': 'Reset',
        'ef.constraint.softness': 'Softness',
        'ef.constraint.owner_local': 'Owner Local',
        'ef.constraint.direction': 'Direction',
        'ef.constraint.a_to_b': 'A to B',
        'ef.constraint.b_to_a': 'B to A',
        'ef.constraint.application_mode': 'Application Mode',
        'ef.constraint.difference_strength': 'Difference Strength',
        'ef.constraint.target_a': 'Target A',
        'ef.constraint.target_b': 'Target B',
        'ef.constraint.source_space_a': 'Source Space A',
        'ef.constraint.source_space_b': 'Source Space B',
        'ef.constraint.blend_weight': 'Blend Weight',
        'ef.constraint.invert_target_a': 'Invert Target A',
        'ef.constraint.invert_target_b': 'Invert Target B',
        'ef.constraint.invert_position_a': 'Invert Target A Displacement',
        'ef.constraint.invert_position_b': 'Invert Target B Displacement',
        'ef.constraint.position_axes': 'Position Axes',
        'ef.constraint.scale_axes': 'Scale Axes',
        'ef.constraint.reciprocal_scale_a': 'Reciprocal Target A Scale',
        'ef.constraint.reciprocal_scale_b': 'Reciprocal Target B Scale',
        'ef.constraint.linear': 'Linear',
        'ef.constraint.logarithmic': 'Logarithmic',
        'ef.constraint.copy_scale': 'Copy Scale',
        'ef.constraint.maintain_volume': 'Maintain Volume',
        'ef.constraint.reference_scale': 'Reference Scale',
        'ef.constraint.maintain_volume_main_axis.desc': 'Scale axis used to calculate the current-to-reference ratio; X, Y or Z',
        'ef.constraint.reset_reference_scale': 'Reset',
        'ef.constraint.compensation_mode': 'Compensation Mode',
        'ef.constraint.compensation_volume': 'Volume',
        'ef.constraint.compensation_area': 'Area',
        'ef.constraint.compensation_uniform': 'Uniform',
        'ef.constraint.compensation_custom': 'Custom',
        'ef.constraint.exponent': 'Exponent',
        'ef.constraint.custom_x': 'X Compensation',
        'ef.constraint.custom_y': 'Y Compensation',
        'ef.constraint.custom_z': 'Z Compensation',
        'ef.constraint.min_factor': 'Minimum Factor',
        'ef.constraint.max_factor': 'Maximum Factor',
        'ef.constraint.compensation_weight': 'Compensation Weight',
        'ef.constraint.stretch_to': 'Stretch To',
        'ef.constraint.main_axis': 'Main Axis',
        'ef.constraint.original_length': 'Original Length',
        'ef.constraint.rotation_weight': 'Rotation Weight',
        'ef.constraint.stretch_weight': 'Stretch Weight',
        'ef.constraint.min_stretch_ratio': 'Minimum Stretch Ratio',
        'ef.constraint.max_stretch_ratio': 'Maximum Stretch Ratio',
        'ef.constraint.volume_mode': 'Volume Mode',
        'ef.constraint.volume_none': 'None',
        'ef.constraint.volume_preserve': 'Preserve Volume',
        'ef.constraint.volume_exponent': 'Volume Exponent',
        'ef.constraint.capture_stretch': 'Capture Length / Offset',
        'ef.constraint.transform_mapping': 'Transform Mapping',
        'ef.constraint.action_constraint': 'Action Constraint',
        'ef.constraint.action': 'Action',
        'ef.constraint.driver_channel': 'Driver Channel',
        'ef.constraint.driver_axis': 'Driver Axis',
        'ef.constraint.input_min': 'Input Min',
        'ef.constraint.input_max': 'Input Max',
        'ef.constraint.action_start': 'Action Start',
        'ef.constraint.action_end': 'Action End',
        'ef.constraint.mapping_mode': 'Mapping',
        'ef.constraint.mapping_clamp': 'Clamp',
        'ef.constraint.mapping_loop': 'Loop',
        'ef.constraint.mapping_pingpong': 'Ping-Pong',
        'ef.constraint.reverse': 'Reverse',
        'ef.constraint.sample_channels': 'Sample Channels',
        'ef.constraint.source_channel': 'Source Channel',
        'ef.constraint.target_channel': 'Target Channel',
        'ef.constraint.source_space': 'Source Space',
        'ef.constraint.target_space': 'Target Space',
        'ef.constraint.axis_mapping': 'Axis Mapping',
        'ef.constraint.from_min': 'From Min',
        'ef.constraint.from_max': 'From Max',
        'ef.constraint.to_min': 'To Min',
        'ef.constraint.to_max': 'To Max',
        'ef.constraint.extrapolate': 'Extrapolate',
        'ef.constraint.clamp': 'Clamp',
        'ef.constraint.mix_mode': 'Mix Mode',
        'ef.constraint.before': 'Before',
        'ef.constraint.after': 'After',
        'ef.constraint.channels': 'Channels',
        'ef.constraint.shortest_slerp': 'Shortest Path Slerp',
        'ef.constraint.normalized_nlerp': 'Normalized Linear Nlerp',
        'ef.constraint.invert_target': 'Invert Target Rotation',
        'ef.constraint.floor_drop': 'Floor Drop',
        'ef.constraint.shrinkwrap': 'Shrinkwrap',
        'ef.constraint.shrinkwrap_mode': 'Wrap Mode',
        'ef.constraint.shrinkwrap_nearest': 'Nearest Surface',
        'ef.constraint.shrinkwrap_project': 'Project',
        'ef.constraint.project_axis': 'Projection Axis',
        'ef.constraint.bidirectional': 'Bidirectional',
        'ef.constraint.flip_normal': 'Flip Normal',
        'ef.constraint.floor': 'Floor',
        'ef.constraint.pivot': 'Pivot',
        'ef.constraint.axis': 'Axis',
        'ef.constraint.drop_axis': 'Drop Axis',
        'ef.constraint.direction_space': 'Direction Space',
        'ef.constraint.surface_offset': 'Surface Offset',
        'ef.constraint.max_distance': 'Maximum Distance',
        'ef.constraint.align_rotation': 'Align Rotation',
        'ef.constraint.floor_drop_mode': 'Mode',
        'ef.constraint.floor_drop_mode_snap': 'Snap',
        'ef.constraint.floor_drop_mode_above_only': 'Above Only',
        'ef.constraint.offset': 'Offset',
        'ef.constraint.prevent_penetration': 'Prevent Penetration',
        'ef.constraint.snap_to_plane': 'Snap to Plane',
        'ef.constraint.angle': 'Angle',
        'ef.constraint.keep_radius': 'Keep Radius',
        'ef.constraint.follow_rotation': 'Follow Rotation',
        'ef.constraint.target_local': 'Target Local',
        'ef.constraint.replace': 'Replace',
        'ef.constraint.add': 'Add',
        'ef.constraint.group_transform': 'Transform & Copy',
        'ef.constraint.group_blend': 'Blend & Difference',
        'ef.constraint.group_limit': 'Limit & Surface',
        'ef.constraint.group_track': 'Track & Path',
        'ef.constraint.group_relation': 'Relation & Action',
        'ef.constraint.group_advanced': 'Advanced',
        'ef.constraint.multiply': 'Multiply',
        'ef.constraint.limit_transform': 'Limit Transform',
        'ef.constraint.limit_position': 'Limit Position',
        'ef.constraint.limit_rotation': 'Limit Rotation',
        'ef.constraint.limit_scale': 'Limit Scale',
        'ef.constraint.child_of': 'Child Of',
        'ef.constraint.armature_blend': 'Armature Blend',
        'ef.constraint.armature_entries': 'Armature Targets',
        'ef.constraint.armature_entry': 'Target',
        'ef.constraint.add_armature_entry': 'Add Target',
        'ef.constraint.remove_armature_entry': 'Remove Target',
        'ef.constraint.normalize_weights': 'Normalize Weights',
        'ef.constraint.capture_armature_offset': 'Capture Offset',
        'ef.constraint.capture_all_offsets': 'Capture All Offsets',
        'ef.constraint.key_armature_weight': 'Set target weight keyframe at current time',
        'ef.constraint.space_switch': 'Space Switch',
        'ef.constraint.follow_path': 'Follow Path',
        'ef.constraint.spline_ik': 'Spline IK',
        'ef.constraint.clamp_to': 'Clamp To',
        'ef.constraint.owner_space': 'Owner Space',
        'ef.constraint.root_follow': 'Root Follow',
        'ef.constraint.stretch': 'Stretch',
        'ef.constraint.volume': 'Preserve Volume',
        'ef.constraint.roll': 'Roll',
        'ef.constraint.spline_bake': 'Bake Entire Spline Chain',
        'ef.constraint.capture_input_range': 'Capture Input Range',
        'ef.constraint.path_points': 'Path Points',
        'ef.constraint.path_point': 'Path Point',
        'ef.constraint.add_path_point': 'Add Path Point',
        'ef.constraint.remove_path_point': 'Remove Path Point',
        'ef.constraint.progress': 'Progress',
        'ef.constraint.key_progress': 'Set path progress keyframe at current time',
        'ef.constraint.interpolation': 'Interpolation',
        'ef.constraint.catmull_rom': 'Catmull-Rom',
        'ef.constraint.closed': 'Closed Loop',
        'ef.constraint.forward_axis': 'Forward Axis',
        'ef.constraint.bank': 'Bank',
        'ef.constraint.position_weight': 'Position Weight',
        'ef.constraint.maintain_rotation_offset': 'Maintain Rotation Offset',
        'ef.constraint.valid_path_required': 'At least two valid, distinct path targets are required',
        'ef.constraint.space_entries': 'Spaces',
        'ef.constraint.space_entry': 'Space',
        'ef.constraint.add_space': 'Add Space',
        'ef.constraint.remove_space': 'Remove Space',
        'ef.constraint.capture_space_offset': 'Capture Offset',
        'ef.constraint.switch_to_space': 'Switch to Space',
        'ef.constraint.key_space_weight': 'Set space weight keyframe at current time',
        'ef.constraint.track_to': 'Track To',
        'ef.constraint.locked_track': 'Locked Track',
        'ef.constraint.damped_track': 'Damped Track',
        'ef.constraint.track_axis': 'Track Axis',
        'ef.constraint.up_axis': 'Up Axis',
        'ef.constraint.lock_axis': 'Lock Axis',
        'ef.constraint.up_space': 'Up Direction',
        'ef.constraint.world_up': 'World Up',
        'ef.constraint.target_local_up': 'Target Local Up',
        'ef.constraint.damping_angle': 'Damping Angle',
        'ef.constraint.target': 'Target',
        'ef.constraint.pick_target': 'Pick in 3D View',
        'ef.constraint.pick_target_hint': 'Click a bone or controller in the 3D view',
        'ef.constraint.space': 'Space',
        'ef.constraint.world': 'World',
        'ef.constraint.local': 'Local',
        'ef.constraint.maintain_offset': 'Maintain Offset',
        'ef.constraint.reset_offset': 'Reset Offset',
        'ef.constraint.position': 'Position',
        'ef.constraint.rotation': 'Rotation',
        'ef.constraint.scale': 'Scale',
        'ef.constraint.set_inverse': 'Set Inverse',
        'ef.constraint.bake_selected': 'Bake',
        'ef.constraint.bake_clear': 'Bake & Clear',
        'ef.constraint.bake_all': 'Bake All',
        'ef.constraint.nothing': 'No constraints to bake',
        'ef.constraint.baked': 'Constraints baked',
        'ef.constraint.add_undo': 'Add constraint',
        'ef.constraint.remove_undo': 'Remove constraint',
        'ef.constraint.reorder_undo': 'Reorder constraints',
        'ef.constraint.edit_undo': 'Edit constraint',
        'ef.constraint.key_undo': 'Key constraint influence',
        'ef.constraint.bake_undo': 'Bake constraints',
        'ef.constraint.copy_transform.desc': 'Copy a target matrix with independent source/output spaces, channel and per-axis controls, replace/before/after composition, matrix offset and final Influence',
        'ef.constraint.action_constraint.desc': 'Map one target transform axis to time in another project action and sample only this owner BoneAnimator without previewing the source action',
        'ef.constraint.action.desc': 'Source project animation; the current action and actions that would create a recursive dependency are unavailable',
        'ef.constraint.driver_channel.desc': 'Target transform channel used to drive source action time',
        'ef.constraint.driver_axis.desc': 'Signed target axis used as the driver value',
        'ef.constraint.action_source_space.desc': 'Read the driver from the target world transform or target local transform',
        'ef.constraint.input_range.desc': 'Map this driver value range to the configured action time range',
        'ef.constraint.action_range.desc': 'Source action interval in seconds',
        'ef.constraint.mapping_mode.desc': 'Clamp at the range ends, repeat, or alternate forward and backward',
        'ef.constraint.reverse.desc': 'Reverse the mapped source action time',
        'ef.constraint.sample_channels.desc': 'Apply sampled position, rotation and scale independently and select X, Y and Z per channel',
        'ef.constraint.action_offset.desc': 'Preserve owner position by addition, rotation by quaternion difference, and scale by safe per-axis ratio',
        'ef.constraint.copy_transform_source_space.desc': 'Read the complete target matrix in world or target-local space',
        'ef.constraint.copy_transform_target_space.desc': 'Compose and apply the result in world or owner-local space',
        'ef.constraint.copy_transform_mix_mode.desc': 'Replace substitutes enabled channels; Before uses sourceMatrix × ownerMatrix; After uses ownerMatrix × sourceMatrix',
        'ef.constraint.copy_transform_channels.desc': 'Enable position, rotation and scale independently, then select each channel\'s X, Y and Z axes',
        'ef.constraint.copy_transform_offset.desc': 'Capture source⁻¹ × owner; target, source/output space or mix mode changes recapture automatically',
        'ef.constraint.copy_position.desc': 'Copy a target\'s position data (optionally with offset) so they move together',
        'ef.constraint.position_blend.desc': 'Blend positions from two independent targets per axis, then apply the result with a separate final Influence',
        'ef.constraint.position_blend_target_a.desc': 'First position source; choose from the list or pick it independently in the 3D view',
        'ef.constraint.position_blend_target_b.desc': 'Second position source; it also participates in dependency ordering',
        'ef.constraint.position_blend_source_space_a.desc': 'Read Target A position in world or target-local space',
        'ef.constraint.position_blend_source_space_b.desc': 'Read Target B position in world or target-local space',
        'ef.constraint.position_blend_target_space.desc': 'Apply the blended position in world or owner-local space; the offset is stored in this output space',
        'ef.constraint.position_blend_weight.desc': 'Blend between Target A at 0 and Target B at 1 before final Influence is applied',
        'ef.constraint.position_blend_axes.desc': 'Enable the blended result independently for X, Y and Z',
        'ef.constraint.invert_position_a.desc': 'Negate Target A displacement from the output-space origin before blending',
        'ef.constraint.invert_position_b.desc': 'Negate Target B displacement from the output-space origin before blending',
        'ef.constraint.position_blend_offset.desc': 'Preserve or recapture the owner offset in output space; target, space, weight and inversion changes recapture it automatically',
        'ef.constraint.copy_rotation.desc': 'Copy a target\'s rotation data (optionally with offset) so they rotate together',
        'ef.constraint.copy_quaternion.desc': 'Copy target rotation as a quaternion with independent source/target spaces and quaternion blending',
        'ef.constraint.rotation_blend.desc': 'Blend rotations from two independent targets, then apply the result with a separate final influence',
        'ef.constraint.rotation_difference.desc': 'Calculate a directional rotation difference, control its strength, then replace or add it before applying final Influence separately',
        'ef.constraint.distance.desc': 'Keep the owner within the configured distance range from the target, using a captured or live direction',
        'ef.constraint.limit_distance.desc': 'Constrain the owner-to-target distance with exact, minimum, maximum or captured initial behavior',
        'ef.constraint.distance_mode.desc': 'Choose exact, minimum, maximum or captured initial distance behavior',
        'ef.constraint.distance_value.desc': 'Distance used by exact, minimum and maximum modes',
        'ef.constraint.initial_distance.desc': 'Distance automatically captured when created, when the target changes or when switching to Initial',
        'ef.constraint.reset_initial_distance.desc': 'Capture the current owner-to-target distance again',
        'ef.constraint.softness.desc': 'Violation depth over which the correction smoothly reaches the full hard limit',
        'ef.constraint.direction.desc': 'Choose whether the difference is inverse(A) × B or inverse(B) × A',
        'ef.constraint.application_mode.desc': 'Replace uses the difference as the target rotation; Add uses current rotation × difference',
        'ef.constraint.difference_strength.desc': 'Slerp from identity to the full rotation difference (0-1), independent of final Influence',
        'ef.constraint.rotation_difference_target_space.desc': 'Evaluate the owner and apply the result in world or owner-local space, converting world output back to local',
        'ef.constraint.rotation_difference_offset.desc': 'Preserve or recapture the offset from the complete difference result; target and parameter changes recapture it automatically',
        'ef.constraint.target_a.desc': 'First rotation source; choose from the list or pick it in the 3D view',
        'ef.constraint.target_b.desc': 'Second rotation source; it also participates in dependency ordering',
        'ef.constraint.source_space_a.desc': 'Read Target A rotation in world or its local space',
        'ef.constraint.source_space_b.desc': 'Read Target B rotation in world or its local space',
        'ef.constraint.blend_weight.desc': 'Blend between Target A at 0 and Target B at 1 before final influence is applied',
        'ef.constraint.invert_target_a.desc': 'Invert Target A quaternion before blending',
        'ef.constraint.invert_target_b.desc': 'Invert Target B quaternion before blending',
        'ef.constraint.rotation_blend_mix_mode.desc': 'Use shortest-path Slerp or normalized Nlerp between Target A and Target B',
        'ef.constraint.rotation_blend_target_space.desc': 'Apply the blended rotation in world or owner-local space',
        'ef.constraint.rotation_blend_offset.desc': 'Preserve or recapture the offset between the owner and the blended result',
        'ef.constraint.scale_blend.desc': 'Blend scale from two independent targets per axis, then apply a separate final Influence',
        'ef.constraint.scale_blend_target_a.desc': 'First scale source; choose from the list or pick it independently in the 3D view',
        'ef.constraint.scale_blend_target_b.desc': 'Second scale source; it also participates in dependency ordering',
        'ef.constraint.scale_blend_source_space_a.desc': 'Read Target A scale in world or target-local space',
        'ef.constraint.scale_blend_source_space_b.desc': 'Read Target B scale in world or target-local space',
        'ef.constraint.scale_blend_target_space.desc': 'Apply the blended scale in world or owner-local space',
        'ef.constraint.scale_blend_weight.desc': 'Blend between Target A at 0 and Target B at 1 before final Influence is applied',
        'ef.constraint.scale_blend_mix_mode.desc': 'Linear interpolates signed scale directly; Logarithmic blends epsilon-safe magnitudes and uses the weight-dominant target sign with exact endpoints',
        'ef.constraint.scale_blend_axes.desc': 'Enable the blended scale independently for X, Y and Z',
        'ef.constraint.reciprocal_scale_a.desc': 'Use an epsilon-safe reciprocal of Target A scale on every axis',
        'ef.constraint.reciprocal_scale_b.desc': 'Use an epsilon-safe reciprocal of Target B scale on every axis',
        'ef.constraint.scale_blend_offset.desc': 'Preserve or recapture the owner-to-blended per-axis scale ratio; target, space, weight, mode and reciprocal changes recapture it automatically',
        'ef.constraint.copy_scale.desc': 'Copy a target\'s scale data (optionally with offset) so they scale together',
        'ef.constraint.maintain_volume.desc': 'Compensate scale on non-main axes from the current-to-reference main-axis ratio, without a target and with final Influence',
        'ef.constraint.reference_scale.desc': 'Absolute main-axis scale captured automatically when created, when the main axis changes, or when reset',
        'ef.constraint.reset_reference_scale.desc': 'Capture the current absolute main-axis scale again with epsilon safety',
        'ef.constraint.compensation_mode.desc': 'Volume uses ratio^(-exponent/2), Area uses ratio^(-exponent), Uniform inversely balances all axes toward equal volume, and Custom uses per-axis weights',
        'ef.constraint.exponent.desc': 'Compensation exponent from 0 to 2',
        'ef.constraint.custom_weight.desc': 'Per-axis custom compensation weight from 0 to 1; the main axis is never compensated',
        'ef.constraint.min_factor.desc': 'Non-negative lower bound for the compensation factor; bounds are automatically ordered',
        'ef.constraint.max_factor.desc': 'Non-negative upper bound for the compensation factor; bounds are automatically ordered',
        'ef.constraint.compensation_weight.desc': 'Blend from no compensation to the selected compensation before final Influence',
        'ef.constraint.stretch_to.desc': 'Aim the main axis at a target and stretch it to the captured length, with stable roll, volume compensation and final Influence',
        'ef.constraint.main_axis.desc': 'Local axis that points at the target and receives longitudinal scale',
        'ef.constraint.original_length.desc': 'Reference distance captured when the constraint is created or recaptured',
        'ef.constraint.rotation_weight.desc': 'Strength of the stable orientation before final Influence',
        'ef.constraint.stretch_weight.desc': 'Strength of longitudinal stretching before final Influence',
        'ef.constraint.min_stretch_ratio.desc': 'Minimum allowed target-distance to original-length ratio',
        'ef.constraint.max_stretch_ratio.desc': 'Maximum allowed target-distance to original-length ratio',
        'ef.constraint.volume_mode.desc': 'Choose whether transverse axes compensate to preserve volume',
        'ef.constraint.volume_exponent.desc': 'Strength of transverse volume compensation',
        'ef.constraint.capture_stretch.desc': 'Capture the current target distance and optional rotation offset again',
        'ef.constraint.transform_mapping.desc': 'Map a target\'s transform range to this bone\'s transform range',
        'ef.constraint.shrinkwrap.desc': 'Move an armature bone owner onto the true nearest triangle point or project it along an axis; targets may be a Cube or Mesh, or a Group, bone, Locator or controller containing actual Cube/Mesh descendants; container targets without such descendants produce no hit',
        'ef.constraint.shrinkwrap_mode.desc': 'Nearest Surface searches every target triangle for the true closest point; Project casts a ray along the selected axis and only falls back to a non-degenerate target AABB when no triangle ray hit is available',
        'ef.constraint.project_axis.desc': 'Projection ray direction; it can be evaluated in world space or rotated by the target transform',
        'ef.constraint.bidirectional.desc': 'Cast in both the selected and opposite directions, then use the nearest hit',
        'ef.constraint.flip_normal.desc': 'Reverse the resolved triangle or AABB surface normal before applying offset and rotation alignment',
        'ef.constraint.shrinkwrap_up_axis.desc': 'Owner local axis aligned to the resolved surface normal',
        'ef.constraint.shrinkwrap_rotation_weight.desc': 'Blend amount used to align the owner rotation to the resolved surface normal',
        'ef.constraint.shrinkwrap_rotation_offset.desc': 'Preserve or recapture the current world rotation relative to the resolved surface orientation',
        'ef.constraint.floor_drop.desc': 'Project the bone along one signed axis onto the infinite plane at the target with its local normal, with independent position, rotation and final Influence',
        'ef.constraint.floor_drop_target.desc': 'Plane origin and orientation source; choose a bone, controller or locator, or pick it in the 3D view',
        'ef.constraint.drop_axis.desc': 'Signed ray direction used exclusively for the plane intersection',
        'ef.constraint.direction_space.desc': 'Interpret the drop axis in world space or rotate it by the target\'s local orientation',
        'ef.constraint.surface_offset.desc': 'Move the hit position along the plane normal after intersection',
        'ef.constraint.max_distance.desc': 'Maximum non-negative ray parameter; 0 means unlimited',
        'ef.constraint.floor_drop_mode.desc': 'Snap accepts every forward hit; Above Only requires the bone on the normal-allowed side and a ray pointing toward the plane',
        'ef.constraint.align_rotation.desc': 'Align the selected local up axis to the plane normal while preserving a stable projected tangent heading',
        'ef.constraint.floor_drop_up_axis.desc': 'Unsigned local bone axis aligned to the plane normal',
        'ef.constraint.floor_drop_rotation_weight.desc': 'Rotation strength from 0 to 1 before final Influence',
        'ef.constraint.floor_drop_rotation_offset.desc': 'Preserve or recapture the current world rotation relative to the aligned surface orientation',
        'ef.constraint.floor.desc': 'Restrict movement to one side of a plane defined by a target',
        'ef.constraint.pivot.desc': 'Rotate the bone around a target\'s pivot point',
        'ef.constraint.limit_position.desc': 'Restrict movement along specified axes',
        'ef.constraint.limit_rotation.desc': 'Restrict rotation along specified axes',
        'ef.constraint.limit_scale.desc': 'Restrict scaling along specified axes',
        'ef.constraint.track_to.desc': 'Continuously point a bone axis toward a target',
        'ef.constraint.locked_track.desc': 'Point toward a target while keeping one axis locked',
        'ef.constraint.damped_track.desc': 'Smoothly rotate toward a target with a damping angle limit',
        'ef.constraint.child_of.desc': 'Make the target a detachable parent of this bone',
        'ef.constraint.armature_blend.desc': 'Blend any number of armature targets with independent animated weights, per-entry source spaces, channel and axis controls, optional offsets and final Influence; this is independent from Space Switch',
        'ef.constraint.armature_entries.desc': 'Ordered target list; every valid target participates in dependency ordering and owns a stable independent weight channel',
        'ef.constraint.armature_entry.desc': 'Choose this armature source from the list or pick it independently in the 3D view',
        'ef.constraint.normalize_weights.desc': 'Normalize valid target weights to 1; when disabled, unused weight preserves the owner transform',
        'ef.constraint.armature_target_space.desc': 'Apply the blended transform in world or owner-local space',
        'ef.constraint.armature_channels.desc': 'Enable position, rotation and scale independently, then enable X, Y and Z per channel',
        'ef.constraint.armature_offset.desc': 'Capture source⁻¹ × owner for one target or all targets in their configured source and output spaces',
        'ef.constraint.armature_weight.desc': 'Independent 0-1 target weight with channel ef_armature_weight_<constraintid>_<entryid>',
        'ef.constraint.space_switch.desc': 'Blend any number of target spaces with independent animated weights while preserving the owner world transform',
        'ef.constraint.follow_path.desc': 'Move along an independent multi-target world path with animated progress, stable tangent orientation, bank, offsets, channel weights and final Influence',
        'ef.constraint.spline_ik.desc': 'Fit a chain from the selected tail bone toward its parents onto the shared path using arc-length sampling, continuous parallel-transport frames, forward/up axes, roll, offset, root follow, stretch, volume preservation and final Influence; overlapping enabled chains are resolved by stack order and each chain can be baked in full',
        'ef.constraint.chain_length.desc': 'Number of bones collected from the selected chain tail toward its parents; 0 uses every available parent bone',
        'ef.constraint.root_follow.desc': 'Move the chain root to the beginning of the fitted path before distributing the remaining bones',
        'ef.constraint.stretch.desc': 'Allow the chain to use the full path length; disabled mode keeps the original chain length',
        'ef.constraint.volume.desc': 'Compensate transverse scale by the inverse square root of longitudinal stretch',
        'ef.constraint.roll.desc': 'Additional rotation in degrees around the continuous path tangent',
        'ef.constraint.spline_bake.desc': 'Bake every bone affected by this Spline IK chain, including bones shared with other enabled chains',
        'ef.constraint.clamp_to.desc': 'Map one signed owner position axis from the configured input range to progress on an independently evaluated world-space path, then apply final Influence',
        'ef.constraint.owner_space.desc': 'Read the owner position in owner-local or world space; path targets are always evaluated in world space',
        'ef.constraint.clamp_driver_axis.desc': 'Signed owner position axis used as the path progress driver',
        'ef.constraint.clamp_input_range.desc': 'Map this owner axis range to path progress from 0 to 1; equal bounds always produce progress 0',
        'ef.constraint.clamp_reverse.desc': 'Reverse the mapped path progress after range mapping',
        'ef.constraint.path_points.desc': 'Ordered path targets; every valid target participates in dependency ordering and at least two distinct valid points are required',
        'ef.constraint.path_point.desc': 'Choose this path point from the list or pick it independently in the 3D view',
        'ef.constraint.progress.desc': 'Position on the path from 0 to 1, animated through the stable dedicated path-progress channel',
        'ef.constraint.interpolation.desc': 'Linear follows straight segments; Catmull-Rom creates a smooth curve through all points',
        'ef.constraint.closed.desc': 'Connect the last path point back to the first and wrap progress continuously',
        'ef.constraint.path_offset.desc': 'World-space vector added to the evaluated path position',
        'ef.constraint.follow_path_rotation.desc': 'Align the selected local forward axis to the stable path tangent',
        'ef.constraint.forward_axis.desc': 'Signed local axis aligned to the path tangent',
        'ef.constraint.path_up_axis.desc': 'Local axis used to stabilize roll; it cannot be parallel to the forward axis',
        'ef.constraint.bank.desc': 'Additional roll angle in degrees around the path tangent',
        'ef.constraint.position_weight.desc': 'Position strength from 0 to 1 before final Influence',
        'ef.constraint.path_rotation_weight.desc': 'Rotation strength from 0 to 1 before final Influence',
        'ef.constraint.maintain_rotation_offset.desc': 'Preserve or recapture the current world rotation relative to the path orientation',
        'ef.constraint.space_entries.desc': 'Every target participates in dependency ordering and has a stable independent weight channel',
        'ef.constraint.space_entry.desc': 'Choose this space target from the list or pick it independently in the 3D view',
        'ef.constraint.capture_space_offset.desc': 'Capture targetWorld⁻¹ × ownerWorld for this entry to preserve the current world transform',
        'ef.constraint.switch_to_space.desc': 'Capture this offset first, then set this entry to 1 and all other entries to 0 without a jump',
        'ef.constraint.target.desc': 'The bone, controller or locator to constrain to',
        'ef.constraint.influence.desc': 'Blend weight between original and constrained transform (0-1)',
        'ef.constraint.space.desc': 'Coordinate space for evaluating the constraint',
        'ef.constraint.maintain_offset.desc': 'Preserve the initial offset between bone and target',
        'ef.constraint.reset_offset.desc': 'Recapture the current offset',
        'ef.constraint.axis.desc': 'Axis used as plane normal or rotation axis',
        'ef.constraint.offset.desc': 'Shift the plane along its normal',
        'ef.constraint.prevent_penetration.desc': 'Only push back when penetrating the forbidden side',
        'ef.constraint.angle.desc': 'Rotation angle around the pivot',
        'ef.constraint.keep_radius.desc': 'Maintain distance to the rotation axis',
        'ef.constraint.follow_rotation.desc': 'Also rotate bone orientation around the axis',
        'ef.constraint.track_axis.desc': 'Bone axis that points toward the target',
        'ef.constraint.up_axis.desc': 'Axis used to resolve roll orientation',
        'ef.constraint.lock_axis.desc': 'Axis kept fixed during tracking',
        'ef.constraint.up_space.desc': 'Source of the up direction',
        'ef.constraint.damping_angle.desc': 'Maximum rotation per evaluation in degrees',
        'ef.constraint.source_channel.desc': 'Which transform channel to read from the target',
        'ef.constraint.target_channel.desc': 'Which transform channel to apply on this bone',
        'ef.constraint.source_space.desc': 'Coordinate space for reading the source',
        'ef.constraint.target_space.desc': 'Coordinate space for applying the result',
        'ef.constraint.quaternion_source_space.desc': 'Read the target quaternion in world or target-local space',
        'ef.constraint.quaternion_target_space.desc': 'Blend and apply the quaternion in world or owner-local space',
        'ef.constraint.axis_mapping.desc': 'Which source axis maps to each target axis',
        'ef.constraint.from_min.desc': 'Input range minimum from the source',
        'ef.constraint.from_max.desc': 'Input range maximum from the source',
        'ef.constraint.to_min.desc': 'Output range minimum for the target',
        'ef.constraint.to_max.desc': 'Output range maximum for the target',
        'ef.constraint.extrapolate.desc': 'Continue mapping beyond the input range',
        'ef.constraint.clamp.desc': 'Clamp output to the target range',
        'ef.constraint.mix_mode.desc': 'How to combine mapped values with existing transform',
        'ef.constraint.quaternion_mix_mode.desc': 'Use shortest-path spherical interpolation or normalized linear interpolation',
        'ef.constraint.invert_target.desc': 'Use the inverse of the source quaternion before applying offset and influence',
        'ef.constraint.set_inverse.desc': 'Recapture the current relative transform as offset',
        'ef.constraint.bake_selected.desc': 'Bake constraints on the selected bone to keyframes',
        'ef.constraint.bake_clear.desc': 'Bake and then remove constraints from the selected bone',
        'ef.constraint.bake_all.desc': 'Bake constraints on all bones and remove them',
        'ef.constraint.enable': 'Enable constraint',
        'ef.constraint.disable': 'Disable constraint',
        'ef.constraint.move_up': 'Move up',
        'ef.constraint.move_down': 'Move down',
        'ef.constraint.remove': 'Remove constraint',
        'ef.constraint.key_influence': 'Set influence keyframe at current time'
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
        'ef.ik.chain_length.desc': '每根选中骨骼都会按自身最大链长进行限制。',
        'ef.ik.create_pole': '创建 Pole 目标',
        'ef.ik.create_pole.desc': '为每个新建控制器创建 Pole 目标。',
        'ef.ik.controllers_created': '已处理 IK 控制器：%s',
        'ef.ik.create_batch_undo': '创建 IK 控制器',
        'ef.ik.influence': 'IK 影响权重',
        'ef.ik.iterations': 'CCD 迭代次数',
        'ef.ik.pole_iterations': 'Pole 二次收敛次数',
        'ef.ik.tolerance': '收敛容差',
        'ef.ik.pole_angle': '极向角 (度)',
        'ef.ik.twist_stiffness': '扭转刚度',
        'ef.ik.bake_title': '烘焙动作',
        'ef.ik.frame_start': '起始帧',
        'ef.ik.frame_end': '结束帧',
        'ef.ik.frame_step': '帧步长',
        'ef.ik.only_selected': '仅选中骨骼',
        'ef.ik.visual_keying': '可视插帧',
        'ef.ik.clear_constraints': '清除约束',
        'ef.ik.clear_parents': '清除父级',
        'ef.ik.bake_data': '烘焙数据',
        'ef.ik.pose': '姿态',
        'ef.ik.object': '物体',
        'ef.ik.overwrite': '覆盖当前动作',
        'ef.ik.clean_curves': '清理曲线',
        'ef.ik.bake_undo': '烘焙 IK 动作',
        'ef.ik.baked': 'IK 动作已烘焙',
        'ef.ik.nothing_to_bake': '没有符合烘焙选项的骨骼',
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
        'ef.rig.bake_undo': '烘焙人形 IK/FK',
        'ef.constraint.panel': '约束',
        'ef.constraint.select_bone': '选择一个骨架骨骼以编辑约束',
        'ef.constraint.copy_transform': '复制变换',
        'ef.constraint.copy_position': '复制位置',
        'ef.constraint.position_blend': '位置混合',
        'ef.constraint.copy_rotation': '复制旋转',
        'ef.constraint.copy_quaternion': '复制四元数',
        'ef.constraint.rotation_blend': '旋转混合',
        'ef.constraint.scale_blend': '缩放混合',
        'ef.constraint.rotation_difference': '旋转差值',
        'ef.constraint.distance': '距离限制',
        'ef.constraint.limit_distance': '限制距离',
        'ef.constraint.distance_mode': '模式',
        'ef.constraint.distance_mode_exact': '精确',
        'ef.constraint.distance_mode_minimum': '最小',
        'ef.constraint.distance_mode_maximum': '最大',
        'ef.constraint.distance_mode_initial': '初始',
        'ef.constraint.distance_value': '距离',
        'ef.constraint.initial_distance': '初始距离',
        'ef.constraint.reset_initial_distance': '重设',
        'ef.constraint.softness': '柔和距离',
        'ef.constraint.owner_local': '骨骼局部',
        'ef.constraint.direction': '差值方向',
        'ef.constraint.a_to_b': 'A 到 B',
        'ef.constraint.b_to_a': 'B 到 A',
        'ef.constraint.application_mode': '应用模式',
        'ef.constraint.difference_strength': '差值强度',
        'ef.constraint.target_a': '目标 A',
        'ef.constraint.target_b': '目标 B',
        'ef.constraint.source_space_a': '源空间 A',
        'ef.constraint.source_space_b': '源空间 B',
        'ef.constraint.blend_weight': '混合权重',
        'ef.constraint.invert_target_a': '反转目标 A',
        'ef.constraint.invert_target_b': '反转目标 B',
        'ef.constraint.invert_position_a': '反转目标 A 位移',
        'ef.constraint.invert_position_b': '反转目标 B 位移',
        'ef.constraint.position_axes': '位置轴',
        'ef.constraint.scale_axes': '缩放轴',
        'ef.constraint.reciprocal_scale_a': '目标 A 倒数缩放',
        'ef.constraint.reciprocal_scale_b': '目标 B 倒数缩放',
        'ef.constraint.linear': '线性',
        'ef.constraint.logarithmic': '对数',
        'ef.constraint.copy_scale': '复制缩放',
        'ef.constraint.maintain_volume': '保持体积',
        'ef.constraint.reference_scale': '参考缩放',
        'ef.constraint.maintain_volume_main_axis.desc': '用于计算当前缩放与参考缩放之比的轴，可选 X、Y 或 Z',
        'ef.constraint.reset_reference_scale': '重设',
        'ef.constraint.compensation_mode': '补偿模式',
        'ef.constraint.compensation_volume': '体积',
        'ef.constraint.compensation_area': '面积',
        'ef.constraint.compensation_uniform': '均匀',
        'ef.constraint.compensation_custom': '自定义',
        'ef.constraint.exponent': '指数',
        'ef.constraint.custom_x': 'X 补偿',
        'ef.constraint.custom_y': 'Y 补偿',
        'ef.constraint.custom_z': 'Z 补偿',
        'ef.constraint.min_factor': '最小因子',
        'ef.constraint.max_factor': '最大因子',
        'ef.constraint.compensation_weight': '补偿权重',
        'ef.constraint.stretch_to': '伸缩到',
        'ef.constraint.main_axis': '主轴',
        'ef.constraint.original_length': '原始长度',
        'ef.constraint.rotation_weight': '旋转权重',
        'ef.constraint.stretch_weight': '伸缩权重',
        'ef.constraint.min_stretch_ratio': '最小伸缩比',
        'ef.constraint.max_stretch_ratio': '最大伸缩比',
        'ef.constraint.volume_mode': '体积模式',
        'ef.constraint.volume_none': '无',
        'ef.constraint.volume_preserve': '保持体积',
        'ef.constraint.volume_exponent': '体积指数',
        'ef.constraint.capture_stretch': '捕获长度/偏移',
        'ef.constraint.transform_mapping': '变换映射',
        'ef.constraint.action_constraint': '动作约束',
        'ef.constraint.action': '动作',
        'ef.constraint.driver_channel': '驱动通道',
        'ef.constraint.driver_axis': '驱动轴',
        'ef.constraint.input_min': '输入最小值',
        'ef.constraint.input_max': '输入最大值',
        'ef.constraint.action_start': '动作开始',
        'ef.constraint.action_end': '动作结束',
        'ef.constraint.mapping_mode': '映射',
        'ef.constraint.mapping_clamp': '钳制',
        'ef.constraint.mapping_loop': '循环',
        'ef.constraint.mapping_pingpong': '往返',
        'ef.constraint.reverse': '反向',
        'ef.constraint.sample_channels': '采样通道',
        'ef.constraint.source_channel': '源通道',
        'ef.constraint.target_channel': '目标通道',
        'ef.constraint.source_space': '源空间',
        'ef.constraint.target_space': '目标空间',
        'ef.constraint.axis_mapping': '轴映射',
        'ef.constraint.from_min': '源最小',
        'ef.constraint.from_max': '源最大',
        'ef.constraint.to_min': '目标最小',
        'ef.constraint.to_max': '目标最大',
        'ef.constraint.extrapolate': '外推',
        'ef.constraint.clamp': '钳制',
        'ef.constraint.mix_mode': '混合模式',
        'ef.constraint.before': '前乘',
        'ef.constraint.after': '后乘',
        'ef.constraint.channels': '通道',
        'ef.constraint.shortest_slerp': '最短路径 Slerp',
        'ef.constraint.normalized_nlerp': '归一化线性 Nlerp',
        'ef.constraint.invert_target': '反转目标旋转',
        'ef.constraint.floor_drop': '基面向下取整',
        'ef.constraint.shrinkwrap': '表面收缩包裹',
        'ef.constraint.shrinkwrap_mode': '包裹模式',
        'ef.constraint.shrinkwrap_nearest': '最近表面',
        'ef.constraint.shrinkwrap_project': '轴向投射',
        'ef.constraint.project_axis': '投射轴',
        'ef.constraint.bidirectional': '双向投射',
        'ef.constraint.flip_normal': '翻转法线',
        'ef.constraint.floor': '基面',
        'ef.constraint.pivot': '轴心',
        'ef.constraint.axis': '轴向',
        'ef.constraint.drop_axis': '下落轴',
        'ef.constraint.direction_space': '方向空间',
        'ef.constraint.surface_offset': '表面偏移',
        'ef.constraint.max_distance': '最大距离',
        'ef.constraint.align_rotation': '对齐旋转',
        'ef.constraint.floor_drop_mode': '模式',
        'ef.constraint.floor_drop_mode_snap': '吸附',
        'ef.constraint.floor_drop_mode_above_only': '仅允许侧',
        'ef.constraint.offset': '偏移',
        'ef.constraint.prevent_penetration': '仅阻止穿透',
        'ef.constraint.snap_to_plane': '吸附到平面',
        'ef.constraint.angle': '角度',
        'ef.constraint.keep_radius': '保持半径',
        'ef.constraint.follow_rotation': '旋转跟随',
        'ef.constraint.target_local': '目标局部',
        'ef.constraint.replace': '替换',
        'ef.constraint.add': '相加',
        'ef.constraint.group_transform': '变换与复制',
        'ef.constraint.group_blend': '混合与差值',
        'ef.constraint.group_limit': '限制与表面',
        'ef.constraint.group_track': '跟踪与路径',
        'ef.constraint.group_relation': '关系与动作',
        'ef.constraint.group_advanced': '高级',
        'ef.constraint.multiply': '相乘',
        'ef.constraint.limit_transform': '限制变换',
        'ef.constraint.limit_position': '限制位置',
        'ef.constraint.limit_rotation': '限制旋转',
        'ef.constraint.limit_scale': '限制缩放',
        'ef.constraint.child_of': '子级关系',
        'ef.constraint.armature_blend': '骨架混合',
        'ef.constraint.armature_entries': '骨架目标',
        'ef.constraint.armature_entry': '目标',
        'ef.constraint.add_armature_entry': '添加目标',
        'ef.constraint.remove_armature_entry': '删除目标',
        'ef.constraint.normalize_weights': '归一化权重',
        'ef.constraint.capture_armature_offset': '捕获偏移',
        'ef.constraint.capture_all_offsets': '捕获全部偏移',
        'ef.constraint.key_armature_weight': '在当前时间设置目标权重关键帧',
        'ef.constraint.space_switch': '空间切换',
        'ef.constraint.follow_path': '跟随路径',
        'ef.constraint.clamp_to': '钳制到路径',
        'ef.constraint.owner_space': 'Owner 空间',
        'ef.constraint.path_points': '路径点',
        'ef.constraint.path_point': '路径点',
        'ef.constraint.add_path_point': '添加路径点',
        'ef.constraint.remove_path_point': '删除路径点',
        'ef.constraint.progress': '进度',
        'ef.constraint.key_progress': '在当前时间设置路径进度关键帧',
        'ef.constraint.interpolation': '插值',
        'ef.constraint.catmull_rom': 'Catmull-Rom',
        'ef.constraint.closed': '闭合循环',
        'ef.constraint.forward_axis': '前向轴',
        'ef.constraint.bank': '倾斜角',
        'ef.constraint.position_weight': '位置权重',
        'ef.constraint.maintain_rotation_offset': '保持旋转偏移',
        'ef.constraint.valid_path_required': '至少需要两个有效且不同的路径目标',
        'ef.constraint.space_entries': '目标空间',
        'ef.constraint.space_entry': '空间项',
        'ef.constraint.add_space': '添加空间',
        'ef.constraint.remove_space': '删除空间',
        'ef.constraint.capture_space_offset': '捕获偏移',
        'ef.constraint.switch_to_space': '切换到该空间',
        'ef.constraint.key_space_weight': '在当前时间设置该空间权重关键帧',
        'ef.constraint.track_to': '标准跟踪',
        'ef.constraint.locked_track': '锁定跟踪',
        'ef.constraint.damped_track': '阻尼跟踪',
        'ef.constraint.track_axis': '跟踪轴',
        'ef.constraint.up_axis': '上轴',
        'ef.constraint.lock_axis': '锁定轴',
        'ef.constraint.up_space': '上方向',
        'ef.constraint.world_up': '世界上方向',
        'ef.constraint.target_local_up': '目标局部上方向',
        'ef.constraint.damping_angle': '阻尼角',
        'ef.constraint.target': '目标',
        'ef.constraint.pick_target': '在 3D 视图拾取',
        'ef.constraint.pick_target_hint': '在 3D 视图中点击骨骼或控制器',
        'ef.constraint.space': '空间',
        'ef.constraint.world': '世界',
        'ef.constraint.local': '局部',
        'ef.constraint.maintain_offset': '保持偏移',
        'ef.constraint.reset_offset': '重设偏移',
        'ef.constraint.position': '位置',
        'ef.constraint.rotation': '旋转',
        'ef.constraint.scale': '缩放',
        'ef.constraint.set_inverse': '设置反矩阵',
        'ef.constraint.bake_selected': '烘焙',
        'ef.constraint.bake_clear': '烘焙并清除',
        'ef.constraint.bake_all': '全部烘焙',
        'ef.constraint.nothing': '没有可烘焙的约束',
        'ef.constraint.baked': '约束已烘焙',
        'ef.constraint.add_undo': '添加约束',
        'ef.constraint.remove_undo': '删除约束',
        'ef.constraint.reorder_undo': '重排约束',
        'ef.constraint.edit_undo': '编辑约束',
        'ef.constraint.key_undo': '设置约束影响关键帧',
        'ef.constraint.bake_undo': '烘焙约束',
        'ef.constraint.copy_transform.desc': '以独立源/输出空间复制目标矩阵，支持通道与逐轴控制、替换/前乘/后乘、矩阵偏移和最终独立 Influence',
        'ef.constraint.action_constraint.desc': '把目标的一个变换轴映射到项目中另一动作的时间，仅采样该 owner 的 BoneAnimator，不预览源动作',
        'ef.constraint.action.desc': '源项目动画；当前动作及会形成递归依赖的动作不可选',
        'ef.constraint.driver_channel.desc': '用于驱动源动作时间的目标变换通道',
        'ef.constraint.driver_axis.desc': '读取驱动值的带正负号目标坐标轴',
        'ef.constraint.action_source_space.desc': '从目标世界变换或目标局部变换读取驱动值',
        'ef.constraint.input_range.desc': '把此驱动值范围映射到配置的动作时间范围',
        'ef.constraint.action_range.desc': '源动作的秒数区间',
        'ef.constraint.mapping_mode.desc': '在范围端点钳制、循环重复或正反往返',
        'ef.constraint.reverse.desc': '反向映射源动作时间',
        'ef.constraint.sample_channels.desc': '分别应用采样的位置、旋转和缩放，并逐通道选择 X、Y、Z',
        'ef.constraint.action_offset.desc': '位置使用加法、旋转使用四元数差、缩放使用安全逐轴比例保持 owner 偏移',
        'ef.constraint.copy_transform_source_space.desc': '在世界空间或目标自身局部空间读取完整目标矩阵',
        'ef.constraint.copy_transform_target_space.desc': '在世界空间或当前骨骼局部空间组合并应用结果',
        'ef.constraint.copy_transform_mix_mode.desc': '替换按启用通道替换；前乘为 sourceMatrix × ownerMatrix；后乘为 ownerMatrix × sourceMatrix',
        'ef.constraint.copy_transform_channels.desc': '分别启用位置、旋转、缩放通道，并独立选择各通道的 X、Y、Z 轴',
        'ef.constraint.copy_transform_offset.desc': '捕获 source⁻¹ × owner；目标、源/输出空间或混合模式变化时自动重捕获',
        'ef.constraint.copy_position.desc': '复制一个物体的位置数据（可选择连同偏移量一同复制），以便让它们同步移动',
        'ef.constraint.position_blend.desc': '从两个独立目标逐轴混合位置，再通过单独的最终 Influence 应用到当前骨骼',
        'ef.constraint.position_blend_target_a.desc': '第一个位置源，可从下拉框选择或在 3D 视图中独立拾取',
        'ef.constraint.position_blend_target_b.desc': '第二个位置源，同时参与约束依赖排序',
        'ef.constraint.position_blend_source_space_a.desc': '在世界空间或目标 A 自身局部空间读取位置',
        'ef.constraint.position_blend_source_space_b.desc': '在世界空间或目标 B 自身局部空间读取位置',
        'ef.constraint.position_blend_target_space.desc': '在世界空间或当前骨骼局部空间应用混合位置；偏移按此输出空间保存',
        'ef.constraint.position_blend_weight.desc': '应用最终 Influence 前，在目标 A（0）与目标 B（1）之间混合',
        'ef.constraint.position_blend_axes.desc': '分别启用混合结果的 X、Y、Z 轴',
        'ef.constraint.invert_position_a.desc': '混合前反转目标 A 相对输出空间原点的位移',
        'ef.constraint.invert_position_b.desc': '混合前反转目标 B 相对输出空间原点的位移',
        'ef.constraint.position_blend_offset.desc': '在输出空间保持或重捕获骨骼偏移；目标、空间、权重和反转变化时自动重捕获',
        'ef.constraint.copy_rotation.desc': '复制一个物体的旋转数据（可选择连同偏移量一同复制），以便让它们同步旋转',
        'ef.constraint.copy_quaternion.desc': '以独立源/目标空间和四元数混合方式复制目标旋转，不经过欧拉角',
        'ef.constraint.rotation_blend.desc': '从两个独立目标混合旋转，再通过单独的最终影响权重应用到当前骨骼',
        'ef.constraint.rotation_difference.desc': '按指定方向计算旋转差，以独立强度缩放后替换或叠加，再单独应用最终 Influence',
        'ef.constraint.distance.desc': '将当前骨骼与目标的距离限制在指定范围内，可使用捕获方向或实时方向',
        'ef.constraint.limit_distance.desc': '以精确、最小、最大或捕获的初始模式限制当前骨骼到目标的距离',
        'ef.constraint.distance_mode.desc': '选择精确、最小、最大或捕获初始距离的求解方式',
        'ef.constraint.distance_value.desc': '精确、最小和最大模式使用的距离值',
        'ef.constraint.initial_distance.desc': '创建约束、切换目标或切换到初始模式时自动捕获的距离',
        'ef.constraint.reset_initial_distance.desc': '重新捕获当前骨骼到目标的距离',
        'ef.constraint.softness.desc': '越界深度在此范围内平滑增强修正，达到后应用完整硬限制',
        'ef.constraint.direction.desc': '选择差值为 A⁻¹ × B 或 B⁻¹ × A',
        'ef.constraint.application_mode.desc': '替换以差值作为目标旋转；相加使用 当前旋转 × 差值',
        'ef.constraint.difference_strength.desc': '从单位旋转到完整旋转差进行 Slerp（0-1），与最终 Influence 相互独立',
        'ef.constraint.rotation_difference_target_space.desc': '在世界空间或骨骼局部空间求值并应用；世界结果会正确转换回局部旋转',
        'ef.constraint.rotation_difference_offset.desc': '保持或重新捕获完整差值结果的偏移；目标和相关参数变化时自动重新捕获',
        'ef.constraint.target_a.desc': '第一个旋转源，可用下拉框选择或在 3D 视图拾取',
        'ef.constraint.target_b.desc': '第二个旋转源，同时参与约束依赖排序',
        'ef.constraint.source_space_a.desc': '在世界空间或目标 A 自身局部空间读取旋转',
        'ef.constraint.source_space_b.desc': '在世界空间或目标 B 自身局部空间读取旋转',
        'ef.constraint.blend_weight.desc': '应用最终影响权重前，在目标 A（0）与目标 B（1）之间混合',
        'ef.constraint.invert_target_a.desc': '混合前使用目标 A 四元数的逆旋转',
        'ef.constraint.invert_target_b.desc': '混合前使用目标 B 四元数的逆旋转',
        'ef.constraint.rotation_blend_mix_mode.desc': '在目标 A 与目标 B 之间使用最短路径 Slerp 或归一化 Nlerp',
        'ef.constraint.rotation_blend_target_space.desc': '在世界空间或当前骨骼局部空间应用混合旋转',
        'ef.constraint.rotation_blend_offset.desc': '保持或按当前姿态重新捕获骨骼与混合结果之间的偏移',
        'ef.constraint.scale_blend.desc': '从两个独立目标逐轴混合缩放，再通过单独的最终 Influence 应用到当前骨骼',
        'ef.constraint.scale_blend_target_a.desc': '第一个缩放源，可从下拉框选择或在 3D 视图中独立拾取',
        'ef.constraint.scale_blend_target_b.desc': '第二个缩放源，同时参与约束依赖排序',
        'ef.constraint.scale_blend_source_space_a.desc': '在世界空间或目标 A 自身局部空间读取缩放',
        'ef.constraint.scale_blend_source_space_b.desc': '在世界空间或目标 B 自身局部空间读取缩放',
        'ef.constraint.scale_blend_target_space.desc': '在世界空间或当前骨骼局部空间应用混合缩放',
        'ef.constraint.scale_blend_weight.desc': '应用最终 Influence 前，在目标 A（0）与目标 B（1）之间混合',
        'ef.constraint.scale_blend_mix_mode.desc': '线性模式直接插值带符号缩放；对数模式以 epsilon 安全的绝对值混合，并采用权重主导目标的符号，同时精确保持端点',
        'ef.constraint.scale_blend_axes.desc': '分别启用混合缩放的 X、Y、Z 轴',
        'ef.constraint.reciprocal_scale_a.desc': '逐轴使用目标 A 缩放的 epsilon 安全倒数',
        'ef.constraint.reciprocal_scale_b.desc': '逐轴使用目标 B 缩放的 epsilon 安全倒数',
        'ef.constraint.scale_blend_offset.desc': '保持或重新捕获 owner/blended 逐轴缩放比例；目标、空间、权重、模式和倒数变化时自动重新捕获',
        'ef.constraint.copy_scale.desc': '复制一个物体的缩放数据（可选择连同偏移量一同复制），以便让它们同步缩放',
        'ef.constraint.maintain_volume.desc': '无需目标，按主轴当前绝对缩放与参考缩放之比补偿其他轴，并在最后应用独立 Influence',
        'ef.constraint.reference_scale.desc': '创建、切换主轴或重设时自动捕获的主轴绝对缩放',
        'ef.constraint.reset_reference_scale.desc': '以 epsilon 安全方式重新捕获当前主轴绝对缩放',
        'ef.constraint.compensation_mode.desc': '体积使用 ratio^(-exponent/2)，面积使用 ratio^(-exponent)，均匀模式反向平衡三轴以趋向统一体积，自定义模式使用逐轴权重',
        'ef.constraint.exponent.desc': '补偿指数，范围 0 到 2',
        'ef.constraint.custom_weight.desc': '逐轴自定义补偿权重，范围 0 到 1；主轴始终不补偿',
        'ef.constraint.min_factor.desc': '补偿因子的非负下限；上下限会自动整理顺序',
        'ef.constraint.max_factor.desc': '补偿因子的非负上限；上下限会自动整理顺序',
        'ef.constraint.compensation_weight.desc': '在最终 Influence 前，从无补偿混合到所选补偿结果',
        'ef.constraint.stretch_to.desc': '让主轴稳定朝向目标，并按捕获长度伸缩，支持体积补偿与最终 Influence',
        'ef.constraint.main_axis.desc': '朝向目标并接受纵向缩放的局部轴',
        'ef.constraint.original_length.desc': '创建或重新捕获约束时记录的参考距离',
        'ef.constraint.rotation_weight.desc': '应用最终 Influence 前的稳定朝向强度',
        'ef.constraint.stretch_weight.desc': '应用最终 Influence 前的主轴伸缩强度',
        'ef.constraint.min_stretch_ratio.desc': '目标距离与原始长度比值的下限',
        'ef.constraint.max_stretch_ratio.desc': '目标距离与原始长度比值的上限',
        'ef.constraint.volume_mode.desc': '选择横向轴是否补偿以保持体积',
        'ef.constraint.volume_exponent.desc': '横向体积补偿的强度',
        'ef.constraint.capture_stretch.desc': '重新捕获当前目标距离和可选旋转偏移',
        'ef.constraint.transform_mapping.desc': '将目标物体的变换范围映射到当前骨骼的变换范围',
        'ef.constraint.shrinkwrap.desc': '仅以骨架骨骼作为所有者，将其移动到目标真实三角形最近点或沿轴投射；目标可以是 Cube、Mesh，或包含真实 Cube/Mesh 子模型的 Group、骨骼、Locator、控制器；后者无真实子模型时不会命中',
        'ef.constraint.shrinkwrap_mode.desc': '最近表面会遍历目标全部三角形求真实最近点；轴向投射会沿所选轴发射射线，仅在三角形射线未命中且目标 AABB 非退化时回退到 AABB',
        'ef.constraint.project_axis.desc': '投射射线方向，可按世界空间计算，也可随目标变换旋转',
        'ef.constraint.bidirectional.desc': '同时沿所选方向及其反方向投射，并采用距离最近的命中',
        'ef.constraint.flip_normal.desc': '应用表面偏移和旋转对齐前，翻转解析出的三角形或 AABB 表面法线',
        'ef.constraint.shrinkwrap_up_axis.desc': '与解析出的表面法线对齐的所有者局部轴',
        'ef.constraint.shrinkwrap_rotation_weight.desc': '将所有者旋转对齐到解析表面法线时使用的混合权重',
        'ef.constraint.shrinkwrap_rotation_offset.desc': '保持或重新捕获当前世界旋转相对解析表面朝向的偏移',
        'ef.constraint.floor_drop.desc': '仅沿指定带符号轴把骨骼投射到由目标位置及其局部法线定义的无限平面，并分别控制位置、旋转与最终 Influence',
        'ef.constraint.floor_drop_target.desc': '提供平面原点和朝向；可选择骨骼、控制器或定位器，也可在 3D 视图拾取',
        'ef.constraint.drop_axis.desc': '仅用于射线与平面求交的带正负号方向',
        'ef.constraint.direction_space.desc': '在世界空间解释下落轴，或用目标局部朝向旋转该轴',
        'ef.constraint.surface_offset.desc': '求交后沿平面法线移动命中位置',
        'ef.constraint.max_distance.desc': '允许的最大非负射线参数；0 表示无限',
        'ef.constraint.floor_drop_mode.desc': '吸附接受所有向前命中；仅允许侧要求骨骼位于法线允许侧，且射线朝平面方向',
        'ef.constraint.align_rotation.desc': '将选定局部上轴对齐平面法线，并保持稳定、合理的投影切向朝向',
        'ef.constraint.floor_drop_up_axis.desc': '对齐到平面法线的无符号骨骼局部轴',
        'ef.constraint.floor_drop_rotation_weight.desc': '应用最终 Influence 前的 0 到 1 旋转强度',
        'ef.constraint.floor_drop_rotation_offset.desc': '保持或重新捕获当前世界旋转相对表面对齐旋转的偏移',
        'ef.constraint.floor.desc': '将运动限制在目标定义的平面的一侧',
        'ef.constraint.pivot.desc': '围绕目标的轴心点旋转骨骼',
        'ef.constraint.limit_position.desc': '将运动限制在指定的轴向上',
        'ef.constraint.limit_rotation.desc': '将旋转限制在指定的轴向上',
        'ef.constraint.limit_scale.desc': '将缩放限制在指定的轴向上',
        'ef.constraint.track_to.desc': '让骨骼指定的轴始终指向目标',
        'ef.constraint.locked_track.desc': '朝向目标的同时保持指定轴的方向不变',
        'ef.constraint.damped_track.desc': '以阻尼角限制平滑旋转朝向目标',
        'ef.constraint.child_of.desc': '将目标物体作为主体的可分离父级',
        'ef.constraint.armature_blend.desc': '用任意数量的骨架目标及独立动画权重混合变换，支持每项目标源空间、通道逐轴控制、可选偏移和最终 Influence；完全独立于空间切换',
        'ef.constraint.armature_entries.desc': '有序目标列表；所有有效目标参与依赖排序，且每项拥有稳定独立的权重通道',
        'ef.constraint.armature_entry.desc': '从下拉框选择该骨架源，或在 3D 视图中单独拾取',
        'ef.constraint.normalize_weights.desc': '将有效目标权重归一化为 1；关闭时未使用的剩余权重保留当前骨骼变换',
        'ef.constraint.armature_target_space.desc': '在世界空间或当前骨骼局部空间应用混合结果',
        'ef.constraint.armature_channels.desc': '分别启用位置、旋转和缩放，再为每个通道逐轴启用 X、Y、Z',
        'ef.constraint.armature_offset.desc': '按各自源空间与输出空间为单项目标或全部目标捕获 source⁻¹ × owner',
        'ef.constraint.armature_weight.desc': '独立的 0-1 目标权重，通道名为 ef_armature_weight_<constraintid>_<entryid>',
        'ef.constraint.space_switch.desc': '以独立动画权重混合任意数量的目标空间，同时保持当前骨骼的世界变换',
        'ef.constraint.follow_path.desc': '沿独立的多目标世界路径运动，支持进度动画、稳定切线朝向、倾斜、偏移、通道权重和最终 Influence',
        'ef.constraint.spline_ik.desc': '从选中链尾向父级收集骨骼，沿复用路径以弧长采样和连续平行传输 frame 拟合整链，支持前向/上轴、滚转、偏移、根部跟随、伸展、体积保持与最终 Influence；启用链重叠时按约束栈顺序解决，并可整链烘焙',
        'ef.constraint.chain_length.desc': '从选中链尾向父级收集的骨骼数量；0 表示使用所有可用父级骨骼',
        'ef.constraint.root_follow.desc': '分配整链前，将链根移动到拟合路径的起点',
        'ef.constraint.stretch.desc': '允许整链使用完整路径长度；关闭时保持原始整链长度',
        'ef.constraint.volume.desc': '按纵向伸展比例的平方根倒数补偿横向缩放',
        'ef.constraint.roll.desc': '绕连续路径切线附加的滚转角度（度）',
        'ef.constraint.spline_bake.desc': '烘焙此样条 IK 影响的每根骨骼，包括与其他启用链共享的骨骼',
        'ef.constraint.clamp_to.desc': '将 Owner 位置的一个带正负号坐标轴按配置输入范围映射为独立世界路径进度，再应用最终 Influence',
        'ef.constraint.owner_space.desc': '以 Owner 局部或世界空间读取位置；路径目标始终在世界空间求值',
        'ef.constraint.clamp_driver_axis.desc': '用作路径进度驱动值的带正负号 Owner 位置轴',
        'ef.constraint.clamp_input_range.desc': '将此 Owner 坐标轴范围映射到 0 到 1 的路径进度；范围相等时进度始终为 0',
        'ef.constraint.clamp_reverse.desc': '在范围映射后反转路径进度',
        'ef.constraint.capture_input_range.desc': '将当前带正负号的 Owner 位置轴捕获为输入最小值或最大值',
        'ef.constraint.path_points.desc': '有序路径目标；所有有效目标参与依赖排序，且至少需要两个不同的有效点',
        'ef.constraint.path_point.desc': '可从下拉框选择该路径点，或在 3D 视图中单独拾取',
        'ef.constraint.progress.desc': '路径上的 0 到 1 位置，通过稳定且独立的路径进度通道插帧',
        'ef.constraint.interpolation.desc': '线性沿直线段运动；Catmull-Rom 生成经过所有路径点的平滑曲线',
        'ef.constraint.closed.desc': '将最后一个路径点连接回第一个，并连续循环进度',
        'ef.constraint.path_offset.desc': '添加到路径求值位置的世界空间向量',
        'ef.constraint.follow_path_rotation.desc': '将选定的局部前向轴对齐到稳定路径切线',
        'ef.constraint.forward_axis.desc': '对齐到路径切线的带正负号局部轴',
        'ef.constraint.path_up_axis.desc': '用于稳定滚转的局部轴，不能与前向轴平行',
        'ef.constraint.bank.desc': '绕路径切线附加的倾斜角度（度）',
        'ef.constraint.position_weight.desc': '应用最终 Influence 前的 0 到 1 位置强度',
        'ef.constraint.path_rotation_weight.desc': '应用最终 Influence 前的 0 到 1 旋转强度',
        'ef.constraint.maintain_rotation_offset.desc': '保持或重新捕获当前世界旋转相对路径朝向的偏移',
        'ef.constraint.space_entries.desc': '每个目标都参与依赖排序，并拥有稳定且独立的权重动画通道',
        'ef.constraint.space_entry.desc': '可从下拉框选择该空间目标，或在 3D 视图中单独拾取',
        'ef.constraint.capture_space_offset.desc': '为该项捕获 targetWorld⁻¹ × ownerWorld，以保持当前世界变换',
        'ef.constraint.switch_to_space.desc': '先捕获该项偏移，再将该项权重设为 1、其他项设为 0，确保切换无跳变',
        'ef.constraint.target.desc': '约束目标（骨骼、控制器或定位器）',
        'ef.constraint.influence.desc': '原始变换与约束变换之间的混合权重（0-1）',
        'ef.constraint.space.desc': '约束求值使用的坐标空间',
        'ef.constraint.maintain_offset.desc': '保持骨骼与目标之间的初始偏移',
        'ef.constraint.reset_offset.desc': '按当前姿态重新捕获偏移',
        'ef.constraint.axis.desc': '作为平面法线或旋转轴的轴向',
        'ef.constraint.offset.desc': '沿法线方向移动平面',
        'ef.constraint.prevent_penetration.desc': '仅在穿透禁止侧时才推回',
        'ef.constraint.angle.desc': '围绕轴心旋转的角度',
        'ef.constraint.keep_radius.desc': '保持骨骼到旋转轴的距离',
        'ef.constraint.follow_rotation.desc': '同时旋转骨骼自身朝向',
        'ef.constraint.track_axis.desc': '指向目标的骨骼轴向',
        'ef.constraint.up_axis.desc': '用于确定滚转方向的轴',
        'ef.constraint.lock_axis.desc': '跟踪时保持不变的轴',
        'ef.constraint.up_space.desc': '上方向的来源',
        'ef.constraint.damping_angle.desc': '每次求解的最大旋转角度（度）',
        'ef.constraint.source_channel.desc': '从目标读取的变换通道',
        'ef.constraint.target_channel.desc': '应用到当前骨骼的变换通道',
        'ef.constraint.source_space.desc': '读取源数据的坐标空间',
        'ef.constraint.target_space.desc': '应用结果的坐标空间',
        'ef.constraint.quaternion_source_space.desc': '在世界空间或目标自身局部空间读取目标四元数',
        'ef.constraint.quaternion_target_space.desc': '在世界空间或当前骨骼局部空间混合并应用四元数',
        'ef.constraint.axis_mapping.desc': '源轴到目标轴的映射关系',
        'ef.constraint.from_min.desc': '源输入范围最小值',
        'ef.constraint.from_max.desc': '源输入范围最大值',
        'ef.constraint.to_min.desc': '目标输出范围最小值',
        'ef.constraint.to_max.desc': '目标输出范围最大值',
        'ef.constraint.extrapolate.desc': '超出输入范围后继续按比例映射',
        'ef.constraint.clamp.desc': '将输出钳制在目标范围内',
        'ef.constraint.mix_mode.desc': '映射值与现有变换的组合方式',
        'ef.constraint.quaternion_mix_mode.desc': '选择最短路径球面插值或归一化线性插值',
        'ef.constraint.invert_target.desc': '在应用偏移和影响权重前使用源四元数的逆旋转',
        'ef.constraint.set_inverse.desc': '按当前相对变换重新捕获偏移',
        'ef.constraint.bake_selected.desc': '将选中骨骼的约束烘焙为关键帧',
        'ef.constraint.bake_clear.desc': '烘焙后删除选中骨骼的约束',
        'ef.constraint.bake_all.desc': '烘焙所有骨骼的约束并删除',
        'ef.constraint.enable': '启用约束',
        'ef.constraint.disable': '禁用约束',
        'ef.constraint.move_up': '上移',
        'ef.constraint.move_down': '下移',
        'ef.constraint.remove': '删除约束',
        'ef.constraint.key_influence': '在当前时间设置影响关键帧'
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
            if (ik.targetPosition) _targetPos.copy(ik.targetPosition);
            else _targetPos.setFromMatrixPosition(target.matrixWorld);
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
        efApplyHumanoidMasterSpace(element);
        efUpdateControllerVisual(element);
        if (efGetMasterConfig(element)) {
            const target = efFindNodeByUuid(element.ef_ik.target);
            const armature = efGetOwningArmature(target);
            efGetRigControllers(armature).forEach(controller => {
                if (controller === element || !controller.mesh) return;
                originalNullUpdateTransform.call(NullObject.preview_controller, controller);
                efApplyNullRotation(controller);
                efApplyHumanoidMasterSpace(controller);
                efUpdateControllerVisual(controller);
            });
            efDisplayFK(element);
            efUpdateIKLineHelper();
        }
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
        efApplyHumanoidMasterSpace(element);
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
        const armature = efGetOwningArmature(chainRoot);
        return armature && armature.parent ? armature.parent : 'root';
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
        if (parent !== 'root' && parent.mesh) {
            if (typeof parent.mesh.updateWorldMatrix === 'function') parent.mesh.updateWorldMatrix(true, false);
            else if (scene) scene.updateMatrixWorld(true);
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

        if (settings.create_pole !== false) {
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
            if (parent !== 'root' && parent.mesh) {
                if (typeof parent.mesh.updateWorldMatrix === 'function') parent.mesh.updateWorldMatrix(true, false);
                else if (scene) scene.updateMatrixWorld(true);
                parent.mesh.worldToLocal(poleLocal);
            }
            pole.position[0] = poleLocal.x;
            pole.position[1] = poleLocal.y;
            pole.position[2] = poleLocal.z;
            pole.preview_controller.updateTransform(pole);
            pole.preview_controller.updateSelection(pole);
            created.push(controller, pole);
        } else {
            created.push(controller);
        }
        controller.preview_controller.updateSelection(controller);
        if (!settings.created) {
            Undo.finishEdit(tl('ef.ik.create_undo'));
            Blockbench.showQuickMessage(tl('ef.ik.controller_created'));
        }
        return controller;
    }

    function efApplyHumanoidMasterSpace(controller) {
        if (!controller || !controller.mesh || !controller.ef_ik || controller.ef_ik.rig !== 'epicfight_humanoid' || efGetMasterConfig(controller)) return;
        const target = efFindNodeByUuid(controller.ef_ik.target);
        const armature = efGetOwningArmature(target);
        const master = efGetRigControllers(armature).find(node => efGetMasterConfig(node));
        const masterConfig = efGetMasterConfig(master);
        if (!master || !master.mesh || !masterConfig) return;

        controller._ef_master_space_base_position = controller.mesh.position.clone();
        controller._ef_master_space_base_quaternion = controller.mesh.quaternion.clone();
        controller._ef_master_space_base_scale = controller.mesh.scale.clone();

        const order = Format.euler_order || 'ZYX';
        const restPosition = new THREE.Vector3().fromArray(masterConfig.rest_position || [0, 0, 0]);
        const restRotation = masterConfig.rest_rotation || [0, 0, 0];
        const restQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            Math.degToRad(restRotation[0] || 0),
            Math.degToRad(restRotation[1] || 0),
            Math.degToRad(restRotation[2] || 0),
            order
        ));
        const unitScale = new THREE.Vector3(1, 1, 1);
        const restLocalMatrix = new THREE.Matrix4().compose(restPosition, restQuaternion, unitScale);
        const masterLocalMatrix = new THREE.Matrix4().compose(master.mesh.position, master.mesh.quaternion, unitScale);
        const controllerLocalMatrix = new THREE.Matrix4().compose(
            controller._ef_master_space_base_position,
            controller._ef_master_space_base_quaternion,
            controller._ef_master_space_base_scale
        );
        const followedLocalMatrix = masterLocalMatrix.multiply(restLocalMatrix.invert()).multiply(controllerLocalMatrix);
        followedLocalMatrix.decompose(controller.mesh.position, controller.mesh.quaternion, controller.mesh.scale);
        controller.mesh.rotation.setFromQuaternion(controller.mesh.quaternion, order);
        controller.mesh.updateMatrixWorld(true);
    }

    // pole 作为 Thigh FK 控制器：pole 决定大腿方向，小腿再伸向脚踝
    function efGetControllerRotationDelta(controller) {
        const rest = controller.ef_ik && Array.isArray(controller.ef_ik.rest_rotation) ? controller.ef_ik.rest_rotation : [0, 0, 0];
        const restQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.degToRad(rest[0] || 0), Math.degToRad(rest[1] || 0), Math.degToRad(rest[2] || 0), Format.euler_order || 'ZYX'));
        const currentQuaternion = controller._ef_master_space_base_quaternion || controller.mesh.quaternion;
        return restQuaternion.invert().multiply(currentQuaternion.clone());
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
                    const masterRestPosition = new THREE.Vector3().fromArray(masterConfig.rest_position || [0, 0, 0]);
                    const masterDeltaRotation = efGetControllerRotationDelta(master);
                    restPosition.sub(masterRestPosition).applyQuaternion(masterDeltaRotation).add(master.mesh.position);
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
        if (parent !== 'root' && parent.mesh) {
            if (typeof parent.mesh.updateWorldMatrix === 'function') parent.mesh.updateWorldMatrix(true, false);
            else if (scene) scene.updateMatrixWorld(true);
            parent.mesh.worldToLocal(localPosition);
        }
        controller.position[0] = localPosition.x;
        controller.position[1] = localPosition.y;
        controller.position[2] = localPosition.z;
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
        const legLen = boneWorldPositions[1].end.distanceTo(boneWorldPositions[1].start);

        const hipToPole = poleWorld.clone().sub(hipWorld);
        const poleDir = hipToPole.lengthSq() > 1e-6 ? hipToPole.normalize() : new THREE.Vector3(0, -1, 0);
        const kneeWorld = hipWorld.clone().add(poleDir.multiplyScalar(thighLen));

        // 小腿保持原长，只把末端指向 ankle 控制器方向，避免拉伸
        const kneeToAnkle = ankleTarget.clone().sub(kneeWorld);
        const legDir = kneeToAnkle.lengthSq() > 1e-6 ? kneeToAnkle.normalize() : poleDir.clone();
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
                if (typeof parent.mesh.updateWorldMatrix === 'function') parent.mesh.updateWorldMatrix(true, false);
                else if (scene) scene.updateMatrixWorld(true);
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
    function efGetBakeControllers() {
        return NullObject.all.filter(controller => {
            const config = efGetIKConfig(controller);
            return config && config.enabled !== false && efFindNodeByUuid(config.target) instanceof ArmatureBone;
        });
    }

    function efGetBakeBones(controllers, onlySelected) {
        const selected = new Set(ArmatureBone.selected || []);
        const bones = [];
        controllers.forEach(controller => {
            const config = efGetIKConfig(controller);
            const target = efFindNodeByUuid(config.target);
            efCollectIKChain(target, config.chain_length).concat(target).forEach(bone => {
                if ((!onlySelected || selected.has(bone)) && !bones.includes(bone)) bones.push(bone);
            });
        });
        return bones;
    }

    function efGetBakeTimes(animation, startFrame, endFrame, frameStep) {
        const rate = Math.clamp(Number(animation.snapping) || 20, 1, 500);
        const start = Math.max(0, Math.floor(Number(startFrame) || 0));
        const end = Math.max(start, Math.floor(Number(endFrame) || 0));
        const step = Math.max(1, Math.floor(Number(frameStep) || 1));
        const times = [];
        for (let frame = start; frame <= end; frame += step) times.push(Math.min(Number(animation.length) || 0, frame / rate));
        const endTime = Math.min(Number(animation.length) || 0, end / rate);
        if (!times.length || Math.abs(times[times.length - 1] - endTime) > 0.000001) times.push(endTime);
        return times.filter((time, index, values) => !index || Math.abs(time - values[index - 1]) > 0.000001);
    }

    function efGetBakeChannelError(start, sample, end, channel) {
        const duration = end.time - start.time;
        const alpha = duration > 0 ? THREE.MathUtils.clamp((sample.time - start.time) / duration, 0, 1) : 0;
        if (channel === 'rotation') {
            const order = Format.euler_order || 'ZYX';
            const startQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                Math.degToRad(start.rotation[0]), Math.degToRad(start.rotation[1]), Math.degToRad(start.rotation[2]), order
            ));
            const endQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                Math.degToRad(end.rotation[0]), Math.degToRad(end.rotation[1]), Math.degToRad(end.rotation[2]), order
            ));
            const sampleQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                Math.degToRad(sample.rotation[0]), Math.degToRad(sample.rotation[1]), Math.degToRad(sample.rotation[2]), order
            ));
            const interpolated = startQuaternion.clone().slerp(endQuaternion, alpha);
            return 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(interpolated.dot(sampleQuaternion)), 0, 1));
        }
        const expected = new THREE.Vector3().fromArray(start[channel]).lerp(new THREE.Vector3().fromArray(end[channel]), alpha);
        return expected.distanceTo(new THREE.Vector3().fromArray(sample[channel]));
    }

    function efCleanBakeChannel(samples, channel) {
        if (samples.length < 3) return samples;
        const tolerance = channel === 'rotation' ? Math.degToRad(0.01) : 0.0001;
        const keep = new Set([0, samples.length - 1]);
        const simplify = (startIndex, endIndex) => {
            let maxError = tolerance;
            let maxIndex = -1;
            for (let index = startIndex + 1; index < endIndex; index++) {
                const error = efGetBakeChannelError(samples[startIndex], samples[index], samples[endIndex], channel);
                if (error > maxError) {
                    maxError = error;
                    maxIndex = index;
                }
            }
            if (maxIndex < 0) return;
            keep.add(maxIndex);
            simplify(startIndex, maxIndex);
            simplify(maxIndex, endIndex);
        };
        simplify(0, samples.length - 1);
        return samples.filter((sample, index) => keep.has(index));
    }

    function efSampleRawBakeChannel(animation, node, time, channel) {
        const animator = animation.animators && animation.animators[node.uuid];
        if (!animator || !animator[channel] || !animator[channel].length) return null;
        animation.time = time;
        const values = animator.interpolate(channel, false);
        return Array.isArray(values) ? values.map(value => Number(value) || 0) : null;
    }

    function efBakeIKAction(options) {
        const sourceAnimation = Animation.selected;
        const controllers = efGetBakeControllers();
        const externalNodes = Array.isArray(options.nodes) ? [...new Set(options.nodes)].filter(node => node && node.mesh) : null;
        const bakeObjects = options.bake_data === 'object';
        const drivenBones = [];
        const drivingControllers = [];
        const constraintBones = [];
        if (!bakeObjects && options.visual_keying) {
            ArmatureBone.all.forEach(bone => {
                if (!Array.isArray(bone.ef_constraints) || !bone.ef_constraints.some(constraint => constraint && constraint.enabled !== false)) return;
                if (options.only_selected && !(ArmatureBone.selected || []).includes(bone)) return;
                constraintBones.push(bone);
            });
            const armatures = new Set(controllers.map(controller => {
                const config = efGetIKConfig(controller);
                return efGetOwningArmature(efFindNodeByUuid(config.target));
            }).filter(armature => armature));
            armatures.forEach(armature => {
                efGetRigControllers(armature).forEach(controller => {
                    const config = efGetFKConfig(controller) || efGetMasterConfig(controller);
                    const target = config && efFindNodeByUuid(config.target);
                    if (!(target instanceof ArmatureBone) || (options.only_selected && !(ArmatureBone.selected || []).includes(target))) return;
                    if (!drivenBones.includes(target)) drivenBones.push(target);
                    if (!drivingControllers.includes(controller)) drivingControllers.push(controller);
                });
            });
        }
        const nodes = externalNodes || (bakeObjects ? controllers.slice() : [...new Set([...efGetBakeBones(controllers, options.only_selected), ...drivenBones, ...constraintBones])]);
        if (!sourceAnimation || (!externalNodes && !controllers.length && !constraintBones.length) || !nodes.length) {
            Blockbench.showQuickMessage(tl('ef.ik.nothing_to_bake'));
            return false;
        }
        const times = efGetBakeTimes(sourceAnimation, options.frame_start, options.frame_end, options.frame_step);
        const rawChannels = ['rotation', 'position', 'scale'].filter(channel => nodes.some(node => {
            const animator = sourceAnimation.animators && sourceAnimation.animators[node.uuid];
            return animator && animator[channel] && animator[channel].length;
        }));
        const channels = bakeObjects
            ? (options.clear_parents ? ['position', 'rotation'] : ['position'])
            : (options.visual_keying ? ['rotation', 'position', 'scale'] : rawChannels);
        const clearConstraints = options.clear_constraints && options.visual_keying && !bakeObjects;
        const samples = {};
        const priorRotations = {};
        nodes.forEach(node => samples[node.uuid] = []);
        const previousTime = Timeline.time;
        const previousAnimationTime = sourceAnimation.time;
        let targetAnimation = sourceAnimation;
        let editing = false;
        let createdAnimation = false;
        try {
            times.forEach(time => {
                Timeline.time = time;
                sourceAnimation.time = time;
                Animator.preview();
                if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
                nodes.forEach(node => {
                    if (bakeObjects) {
                        if (options.clear_parents) {
                            const position = new THREE.Vector3();
                            const quaternion = new THREE.Quaternion();
                            const scale = new THREE.Vector3();
                            node.mesh.matrixWorld.decompose(position, quaternion, scale);
                            const euler = new THREE.Euler().setFromQuaternion(quaternion, Format.euler_order || 'ZYX');
                            samples[node.uuid].push({
                                time,
                                position: position.toArray(),
                                rotation: [Math.radToDeg(euler.x), Math.radToDeg(euler.y), Math.radToDeg(euler.z)],
                                scale: scale.toArray()
                            });
                        } else {
                            const restPosition = node.mesh.fix_position || new THREE.Vector3().fromArray(node.position || [0, 0, 0]);
                            samples[node.uuid].push({time, position: node.mesh.position.clone().sub(restPosition).toArray()});
                        }
                        return;
                    }
                    if (!options.visual_keying) {
                        const sample = {time};
                        channels.forEach(channel => {
                            const values = efSampleRawBakeChannel(sourceAnimation, node, time, channel);
                            if (values) sample[channel] = values;
                        });
                        samples[node.uuid].push(sample);
                        return;
                    }
                    const restRotation = node.mesh.fix_rotation ? new THREE.Quaternion().setFromEuler(node.mesh.fix_rotation) : new THREE.Quaternion();
                    const deltaQuaternion = restRotation.invert().multiply(node.mesh.quaternion.clone()).normalize();
                    const priorQuaternion = priorRotations[node.uuid] && priorRotations[node.uuid].quaternion;
                    if (priorQuaternion && priorQuaternion.dot(deltaQuaternion) < 0) deltaQuaternion.set(-deltaQuaternion.x, -deltaQuaternion.y, -deltaQuaternion.z, -deltaQuaternion.w);
                    const euler = new THREE.Euler().setFromQuaternion(deltaQuaternion, Format.euler_order || 'ZYX');
                    const rotation = [Math.radToDeg(euler.x), Math.radToDeg(euler.y), Math.radToDeg(euler.z)];
                    const prior = priorRotations[node.uuid] && priorRotations[node.uuid].rotation;
                    if (prior) for (let axis = 0; axis < 3; axis++) {
                        while (rotation[axis] - prior[axis] > 180) rotation[axis] -= 360;
                        while (rotation[axis] - prior[axis] < -180) rotation[axis] += 360;
                    }
                    priorRotations[node.uuid] = {rotation: rotation.slice(), quaternion: deltaQuaternion.clone()};
                    const restPosition = node.mesh.fix_position || new THREE.Vector3().fromArray(node.origin || [0, 0, 0]);
                    samples[node.uuid].push({
                        time,
                        rotation,
                        position: node.mesh.position.clone().sub(restPosition).toArray(),
                        scale: node.mesh.scale.toArray()
                    });
                });
            });
            const startTime = times[0];
            const endTime = times[times.length - 1];
            const constraints = clearConstraints ? [...new Set([
                ...controllers.filter(controller => {
                    const config = efGetIKConfig(controller);
                    const target = efFindNodeByUuid(config.target);
                    return efCollectIKChain(target, config.chain_length).concat(target).every(bone => nodes.includes(bone));
                }).flatMap(controller => [controller, efFindPole(controller)].filter(node => node)),
                ...drivingControllers
            ])] : [];
            const clearedConstraintBones = clearConstraints ? constraintBones.filter(bone => nodes.includes(bone)) : [];
            const reparented = bakeObjects && options.clear_parents ? nodes.filter(node => node.parent !== 'root') : [];
            const affectedElements = [...new Set([...constraints, ...clearedConstraintBones, ...reparented, ...(Array.isArray(options.affected_elements) ? options.affected_elements : [])])];
            const affectedKeyframes = Array.isArray(options.affected_keyframes) ? options.affected_keyframes : [];
            const affectedAnimations = Array.isArray(options.affected_animations) ? options.affected_animations : [];
            if (!options.overwrite) {
                Undo.initEdit({animations: affectedAnimations, elements: affectedElements, keyframes: affectedKeyframes, outliner: affectedElements.length > 0});
                editing = true;
                targetAnimation = new Animation({
                    name: sourceAnimation.name + '_baked',
                    loop: sourceAnimation.loop,
                    override: sourceAnimation.override,
                    length: sourceAnimation.length,
                    snapping: sourceAnimation.snapping
                }).add(false).select();
                createdAnimation = true;
            } else {
                const removed = [];
                nodes.forEach(node => {
                    const animator = targetAnimation.getBoneAnimator(node);
                    if (!animator.group) animator.group = node;
                    channels.forEach(channel => {
                        (animator[channel] || []).forEach(keyframe => {
                            if (keyframe.time >= startTime - 0.000001 && keyframe.time <= endTime + 0.000001) removed.push(keyframe);
                        });
                    });
                });
                Undo.initEdit({animations: [...new Set([targetAnimation, ...affectedAnimations])], elements: affectedElements, keyframes: [...removed, ...affectedKeyframes], outliner: affectedElements.length > 0});
                editing = true;
                removed.forEach(keyframe => keyframe.remove());
            }
            reparented.forEach(node => {
                node.addTo('root');
                node.position.V3_set(0, 0, 0);
                node.rotation.V3_set(0, 0, 0);
                node.preview_controller.updateTransform(node);
            });
            const created = [];
            nodes.forEach(node => {
                const animator = targetAnimation.getBoneAnimator(node);
                if (!animator.group) animator.group = node;
                animator.quaternion_interpolation = true;
                channels.forEach(channel => {
                    const channelSamples = samples[node.uuid].filter(sample => Array.isArray(sample[channel]));
                    const cleanedSamples = options.clean_curves ? efCleanBakeChannel(channelSamples, channel) : channelSamples;
                    cleanedSamples.forEach(sample => {
                        const values = sample[channel];
                        created.push(animator.createKeyframe({x: values[0], y: values[1], z: values[2]}, sample.time, channel, false, false));
                    });
                });
                animator.addToTimeline();
            });
            constraints.forEach(node => node.remove());
            clearedConstraintBones.forEach(bone => bone.ef_constraints = []);
            if (typeof options.clear_callback === 'function') options.clear_callback();
            Undo.finishEdit(options.undo_name || tl('ef.ik.bake_undo'), {animations: [...new Set([targetAnimation, ...affectedAnimations])], elements: affectedElements, keyframes: [...created, ...affectedKeyframes], outliner: affectedElements.length > 0});
            editing = false;
            Blockbench.showQuickMessage(options.success_message || tl('ef.ik.baked'));
        } catch (error) {
            if (editing && typeof Undo.cancelEdit === 'function') Undo.cancelEdit(true);
            else if (createdAnimation && Animation.all.includes(targetAnimation)) targetAnimation.remove(false, false);
            throw error;
        } finally {
            sourceAnimation.time = previousAnimationTime;
            Timeline.time = previousTime;
            Animator.preview();
        }
        return true;
    }
    globalThis.efBakeVisualAction = efBakeIKAction;

    function efShowBakeIKDialog() {
        const animation = Animation.selected;
        if (!animation) return;
        const rate = Math.clamp(Number(animation.snapping) || 20, 1, 500);
        new Dialog('ef_bake_ik_animation', {
            title: tl('ef.ik.bake_title'),
            form: {
                frame_start: {type: 'number', label: tl('ef.ik.frame_start'), value: 0, min: 0, max: Math.ceil(animation.length * rate), step: 1},
                frame_end: {type: 'number', label: tl('ef.ik.frame_end'), value: Math.ceil(animation.length * rate), min: 0, max: Math.ceil(animation.length * rate), step: 1},
                frame_step: {type: 'number', label: tl('ef.ik.frame_step'), value: 1, min: 1, max: Math.max(1, Math.ceil(animation.length * rate)), step: 1},
                bake_data: {type: 'select', label: tl('ef.ik.bake_data'), value: 'pose', options: {pose: tl('ef.ik.pose'), object: tl('ef.ik.object')}},
                only_selected: {type: 'checkbox', label: tl('ef.ik.only_selected'), value: false, condition: result => result.bake_data === 'pose'},
                visual_keying: {type: 'checkbox', label: tl('ef.ik.visual_keying'), value: true, condition: result => result.bake_data === 'pose'},
                clear_constraints: {type: 'checkbox', label: tl('ef.ik.clear_constraints'), value: false, condition: result => result.bake_data === 'pose' && result.visual_keying},
                clear_parents: {type: 'checkbox', label: tl('ef.ik.clear_parents'), value: false, condition: result => result.bake_data === 'object'},
                overwrite: {type: 'checkbox', label: tl('ef.ik.overwrite'), value: true},
                clean_curves: {type: 'checkbox', label: tl('ef.ik.clean_curves'), value: true}
            },
            onConfirm(result) {
                efBakeIKAction(result);
            }
        }).show();
    }

    const nativeBakeIKAction = typeof BarItems !== 'undefined' && BarItems.bake_ik_animation;
    const originalBakeIKClick = nativeBakeIKAction && nativeBakeIKAction.click;
    if (nativeBakeIKAction) nativeBakeIKAction.click = efShowBakeIKDialog;

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
            const selectedBones = [...new Set((ArmatureBone.selected || []).filter(bone => bone instanceof ArmatureBone))];
            const bones = selectedBones.filter(bone => efGetMaximumChainLength(bone) > 0);
            if (!bones.length) return;
            const maximum = Math.max(...bones.map(efGetMaximumChainLength));
            const firstExisting = efFindController(bones[0]);
            const firstConfig = efGetIKConfig(firstExisting);
            new Dialog('ef_create_ik_controller_dialog', {
                title: tl('ef.ik.create_controller'),
                form: {
                    chain_length: {
                        type: 'number',
                        label: tl('ef.ik.chain_length'),
                        description: tl('ef.ik.chain_length.desc'),
                        value: firstConfig ? firstConfig.chain_length : Math.min(2, maximum),
                        min: 0,
                        max: maximum,
                        step: 1
                    },
                    create_pole: {
                        type: 'checkbox',
                        label: tl('ef.ik.create_pole'),
                        description: tl('ef.ik.create_pole.desc'),
                        value: true
                    }
                },
                onConfirm(result) {
                    const chainLength = Math.floor(Number(result.chain_length) || 0);
                    const affected = bones.map(efFindController).filter(controller => efGetIKConfig(controller));
                    const editedElements = affected.slice();
                    const createdTargets = [];
                    Undo.initEdit({elements: editedElements, outliner: true});
                    bones.forEach(targetBone => {
                        const maximumForBone = efGetMaximumChainLength(targetBone);
                        const clampedLength = THREE.MathUtils.clamp(chainLength, 0, maximumForBone);
                        const existing = efFindController(targetBone);
                        const existingConfig = efGetIKConfig(existing);
                        if (existingConfig) {
                            existingConfig.chain_length = clampedLength;
                            existing.ef_ik = Object.assign({}, existingConfig);
                        } else {
                            const controller = efCreateController(targetBone, clampedLength, {created: editedElements, create_pole: result.create_pole !== false});
                            if (controller) createdTargets.push(targetBone);
                        }
                    });
                    if (editedElements.length) {
                        if (affected.length) {
                            affected.forEach(controller => controller.ef_ik = Object.assign({}, controller.ef_ik));
                        }
                        Undo.finishEdit(tl('ef.ik.create_batch_undo'));
                        Blockbench.showQuickMessage(tl('ef.ik.controllers_created') + ': ' + (createdTargets.length + affected.length));
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
        condition: () => Modes.animate && Animation.selected && ArmatureBone.all.length > 0,
        click: efShowBakeIKDialog
    }));
    MenuBar.addAction(ikActions[5], 'tools');

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
            if (nativeBakeIKAction && nativeBakeIKAction.click === efShowBakeIKDialog) nativeBakeIKAction.click = originalBakeIKClick;
            NullObjectAnimator.prototype.displayIK = origDisplayIK;
            NullObjectAnimator.prototype.displayFrame = originalNullDisplayFrame;
            NullObjectAnimator.prototype.channels = originalNullChannels;
            if (globalThis.efBakeVisualAction === efBakeIKAction) delete globalThis.efBakeVisualAction;
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

function efSetupConstraintSupport() {
    if (typeof ArmatureBone === 'undefined' || typeof Panel === 'undefined' || typeof Animator === 'undefined') return null;
    const properties = [];
    if (typeof Property !== 'undefined' && (!ArmatureBone.properties || !ArmatureBone.properties.ef_constraints)) {
        properties.push(new Property(ArmatureBone, 'array', 'ef_constraints'));
    }
    if (typeof Property !== 'undefined' && typeof Keyframe !== 'undefined' && (!Keyframe.properties || !Keyframe.properties.ef_constraint_id)) {
        properties.push(new Property(Keyframe, 'string', 'ef_constraint_id'));
    }
    const animatorPrototype = ArmatureBone.animator && ArmatureBone.animator.prototype;
    const originalChannels = animatorPrototype && animatorPrototype.channels;
    if (animatorPrototype) {
        animatorPrototype.channels = Object.assign({}, originalChannels, {
            influence: {name: tl('ef.ik.influence'), mutable: true, transform: true, max_data_points: 1}
        });
        Object.keys((typeof Animation !== 'undefined' && Animation.selected && Animation.selected.animators) || {}).forEach(uuid => {
            const animator = Animation.selected.animators[uuid];
            if (animator instanceof ArmatureBone.animator && !Array.isArray(animator.influence)) animator.influence = [];
        });
    }
    const constraintId = () => 'ef_constraint_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const armatureEntryId = () => 'ef_armature_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const spaceEntryId = () => 'ef_space_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const pathPointId = () => 'ef_path_point_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const cloneValue = value => JSON.parse(JSON.stringify(value));
    const allConstraintTargets = () => [...new Set([
        ...ArmatureBone.all,
        ...(typeof Cube !== 'undefined' ? Cube.all : []),
        ...(typeof Mesh !== 'undefined' ? Mesh.all : []),
        ...(typeof Group !== 'undefined' ? Group.all : []),
        ...(typeof Locator !== 'undefined' ? Locator.all : []),
        ...(typeof NullObject !== 'undefined' ? NullObject.all : [])
    ])];
    const findNode = uuid => allConstraintTargets().find(node => node.uuid === uuid);
    const selectedBone = () => ArmatureBone.selected && ArmatureBone.selected[0];
    const finiteNonNegative = (value, fallback) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, number) : fallback;
    };
    const distanceModes = ['exact', 'minimum', 'maximum', 'initial'];
    const normalizeDistanceConstraint = constraint => {
        if (!constraint || !['distance', 'limit_distance'].includes(constraint.type)) return constraint;
        const legacyType = constraint.type === 'distance';
        const legacyDistance = finiteNonNegative(constraint.distance, 0);
        const hasMin = Number.isFinite(Number(constraint.min_distance));
        const hasMax = Number.isFinite(Number(constraint.max_distance));
        const minDistance = hasMin ? finiteNonNegative(constraint.min_distance, 0) : legacyDistance;
        const maxDistance = hasMax ? finiteNonNegative(constraint.max_distance, 0) : legacyDistance;
        if (legacyType) {
            constraint.mode = hasMin && hasMax && minDistance === maxDistance ? 'exact' : hasMin || hasMax ? 'maximum' : 'exact';
            constraint.distance = constraint.mode === 'exact' ? minDistance : hasMax ? maxDistance : minDistance;
        }
        constraint.type = 'limit_distance';
        if (!distanceModes.includes(constraint.mode)) constraint.mode = 'exact';
        constraint.distance = finiteNonNegative(constraint.distance, finiteNonNegative(constraint.initial_distance, 0));
        constraint.initial_distance = finiteNonNegative(constraint.initial_distance, constraint.distance);
        constraint.softness = finiteNonNegative(constraint.softness, 0);
        delete constraint.min_distance;
        delete constraint.max_distance;
        delete constraint.keep_direction;
        delete constraint.direction_space;
        delete constraint.captured_direction;
        return constraint;
    };
    const normalizeCopyConstraint = constraint => {
        if (!constraint || constraint.type !== 'copy_transform' || !constraint.space || constraint.source_space) return constraint;
        constraint.type = 'copy_channels';
        return constraint;
    };
    const normalizeArmatureBlend = constraint => {
        if (!constraint || constraint.type !== 'armature_blend') return constraint;
        constraint.entries = (Array.isArray(constraint.entries) ? constraint.entries : []).map(entry => ({
            id: entry && entry.id ? entry.id : armatureEntryId(),
            target: entry && entry.target ? entry.target : '',
            weight: THREE.MathUtils.clamp(Number.isFinite(Number(entry && entry.weight)) ? Number(entry.weight) : 0, 0, 1),
            source_space: entry && entry.source_space === 'local' ? 'local' : 'world',
            offset_matrix: entry && Array.isArray(entry.offset_matrix) && entry.offset_matrix.length === 16 ? entry.offset_matrix : new THREE.Matrix4().toArray()
        }));
        constraint.target_space = constraint.target_space === 'local' ? 'local' : 'world';
        constraint.normalize_weights = constraint.normalize_weights !== false;
        constraint.maintain_offset = constraint.maintain_offset === true;
        constraint.channels = Object.assign({position: true, rotation: true, scale: true}, constraint.channels || {});
        ['position_axes', 'rotation_axes', 'scale_axes'].forEach(field => constraint[field] = Object.assign({x: true, y: true, z: true}, constraint[field] || {}));
        return constraint;
    };
    const normalizeFloorDrop = constraint => {
        if (!constraint || constraint.type !== 'floor_drop') return constraint;
        constraint.drop_axis = ['x', '-x', 'y', '-y', 'z', '-z'].includes(constraint.drop_axis) ? constraint.drop_axis : '-y';
        constraint.direction_space = constraint.direction_space === 'target' ? 'target' : 'world';
        constraint.surface_offset = Number.isFinite(Number(constraint.surface_offset)) ? Number(constraint.surface_offset) : 0;
        constraint.max_distance = finiteNonNegative(constraint.max_distance, 0);
        constraint.mode = constraint.mode === 'above_only' ? 'above_only' : 'snap';
        constraint.position_weight = THREE.MathUtils.clamp(Number.isFinite(Number(constraint.position_weight)) ? Number(constraint.position_weight) : 1, 0, 1);
        constraint.align_rotation = constraint.align_rotation === true;
        constraint.up_axis = ['x', 'y', 'z'].includes(constraint.up_axis) ? constraint.up_axis : 'y';
        constraint.rotation_weight = THREE.MathUtils.clamp(Number.isFinite(Number(constraint.rotation_weight)) ? Number(constraint.rotation_weight) : 1, 0, 1);
        constraint.maintain_rotation_offset = constraint.maintain_rotation_offset === true;
        constraint.rotation_offset = Array.isArray(constraint.rotation_offset) && constraint.rotation_offset.length === 4 ? constraint.rotation_offset : [0, 0, 0, 1];
        return constraint;
    };
    const normalizeShrinkwrap = constraint => {
        if (!constraint || constraint.type !== 'shrinkwrap') return constraint;
        constraint.mode = constraint.mode === 'project' ? 'project' : 'nearest_surface';
        constraint.project_axis = ['x', '-x', 'y', '-y', 'z', '-z'].includes(constraint.project_axis) ? constraint.project_axis : '-y';
        constraint.direction_space = constraint.direction_space === 'target' ? 'target' : 'world';
        constraint.surface_offset = Number.isFinite(Number(constraint.surface_offset)) ? Number(constraint.surface_offset) : 0;
        constraint.max_distance = finiteNonNegative(constraint.max_distance, 0);
        constraint.position_weight = THREE.MathUtils.clamp(Number.isFinite(Number(constraint.position_weight)) ? Number(constraint.position_weight) : 1, 0, 1);
        constraint.align_rotation = constraint.align_rotation === true;
        constraint.up_axis = ['x', 'y', 'z'].includes(constraint.up_axis) ? constraint.up_axis : 'y';
        constraint.rotation_weight = THREE.MathUtils.clamp(Number.isFinite(Number(constraint.rotation_weight)) ? Number(constraint.rotation_weight) : 1, 0, 1);
        constraint.flip_normal = constraint.flip_normal === true;
        constraint.bidirectional = constraint.bidirectional === true;
        constraint.maintain_rotation_offset = constraint.maintain_rotation_offset === true;
        constraint.rotation_offset = Array.isArray(constraint.rotation_offset) && constraint.rotation_offset.length === 4 ? constraint.rotation_offset : [0, 0, 0, 1];
        return constraint;
    };
    const normalizeActionConstraint = constraint => {
        if (!constraint || constraint.type !== 'action_constraint') return constraint;
        constraint.action_owner_uuid = typeof constraint.action_owner_uuid === 'string' ? constraint.action_owner_uuid : '';
        constraint.action_uuid = typeof constraint.action_uuid === 'string' ? constraint.action_uuid : '';
        constraint.target = typeof constraint.target === 'string' ? constraint.target : '';
        constraint.driver_channel = ['position', 'rotation', 'scale'].includes(constraint.driver_channel) ? constraint.driver_channel : 'position';
        constraint.driver_axis = ['x', '-x', 'y', '-y', 'z', '-z'].includes(constraint.driver_axis) ? constraint.driver_axis : 'x';
        constraint.source_space = constraint.source_space === 'world' ? 'world' : 'local';
        constraint.input_min = Number.isFinite(Number(constraint.input_min)) ? Number(constraint.input_min) : 0;
        constraint.input_max = Number.isFinite(Number(constraint.input_max)) ? Number(constraint.input_max) : 1;
        constraint.action_start = finiteNonNegative(constraint.action_start, 0);
        constraint.action_end = finiteNonNegative(constraint.action_end, 1);
        constraint.mapping = ['clamp', 'loop', 'pingpong'].includes(constraint.mapping) ? constraint.mapping : 'clamp';
        constraint.reverse = constraint.reverse === true;
        constraint.maintain_offset = constraint.maintain_offset === true;
        constraint.channels = Object.assign({position: true, rotation: true, scale: true}, constraint.channels || {});
        ['position_axes', 'rotation_axes', 'scale_axes'].forEach(field => constraint[field] = Object.assign({x: true, y: true, z: true}, constraint[field] || {}));
        constraint.position_offset = Array.isArray(constraint.position_offset) && constraint.position_offset.length === 3 ? constraint.position_offset : [0, 0, 0];
        constraint.rotation_offset = Array.isArray(constraint.rotation_offset) && constraint.rotation_offset.length === 4 ? constraint.rotation_offset : [0, 0, 0, 1];
        constraint.scale_offset = Array.isArray(constraint.scale_offset) && constraint.scale_offset.length === 3 ? constraint.scale_offset : [1, 1, 1];
        return constraint;
    };
    const normalizeFollowPath = constraint => {
        if (!constraint || !['follow_path', 'clamp_to', 'spline_ik'].includes(constraint.type)) return constraint;
        constraint.path_points = (Array.isArray(constraint.path_points) ? constraint.path_points : []).map(point => ({id: point && point.id ? point.id : pathPointId(), target: point && point.target ? point.target : ''}));
        if (constraint.type === 'spline_ik') {
            constraint.chain_length = Math.max(0, Math.floor(Number(constraint.chain_length) || 0));
            constraint.forward_axis = ['x', '-x', 'y', '-y', 'z', '-z'].includes(constraint.forward_axis) ? constraint.forward_axis : 'y';
            constraint.up_axis = ['x', 'y', 'z'].includes(constraint.up_axis) && constraint.forward_axis.replace('-', '') !== constraint.up_axis ? constraint.up_axis : constraint.forward_axis.replace('-', '') === 'z' ? 'y' : 'z';
            constraint.roll = Number.isFinite(Number(constraint.roll)) ? Number(constraint.roll) : 0;
            constraint.root_follow = constraint.root_follow !== false;
            constraint.stretch = constraint.stretch === true;
            constraint.volume = constraint.volume === true;
        }
        if (constraint.type === 'clamp_to') {
            constraint.driver_axis = ['x', '-x', 'y', '-y', 'z', '-z'].includes(constraint.driver_axis) ? constraint.driver_axis : 'x';
            constraint.owner_space = constraint.owner_space === 'world' ? 'world' : 'local';
            constraint.input_min = Number.isFinite(Number(constraint.input_min)) ? Number(constraint.input_min) : 0;
            constraint.input_max = Number.isFinite(Number(constraint.input_max)) ? Number(constraint.input_max) : 1;
            constraint.reverse = constraint.reverse === true;
        }
        constraint.progress = THREE.MathUtils.clamp(Number.isFinite(Number(constraint.progress)) ? Number(constraint.progress) : 0, 0, 1);
        constraint.interpolation = constraint.interpolation === 'catmull_rom' ? 'catmull_rom' : 'linear';
        constraint.closed = constraint.closed === true;
        constraint.offset = Array.isArray(constraint.offset) && constraint.offset.length === 3 ? constraint.offset.map(value => Number.isFinite(Number(value)) ? Number(value) : 0) : [0, 0, 0];
        constraint.follow_rotation = constraint.follow_rotation === true;
        constraint.forward_axis = ['x', '-x', 'y', '-y', 'z', '-z'].includes(constraint.forward_axis) ? constraint.forward_axis : 'z';
        constraint.up_axis = ['x', 'y', 'z'].includes(constraint.up_axis) && constraint.forward_axis.replace('-', '') !== constraint.up_axis ? constraint.up_axis : constraint.forward_axis.replace('-', '') === 'y' ? 'z' : 'y';
        constraint.bank = Number.isFinite(Number(constraint.bank)) ? Number(constraint.bank) : 0;
        constraint.position_weight = THREE.MathUtils.clamp(Number.isFinite(Number(constraint.position_weight)) ? Number(constraint.position_weight) : 1, 0, 1);
        constraint.rotation_weight = THREE.MathUtils.clamp(Number.isFinite(Number(constraint.rotation_weight)) ? Number(constraint.rotation_weight) : 1, 0, 1);
        constraint.maintain_rotation_offset = constraint.maintain_rotation_offset === true;
        constraint.rotation_offset = Array.isArray(constraint.rotation_offset) && constraint.rotation_offset.length === 4 ? constraint.rotation_offset : [0, 0, 0, 1];
        return constraint;
    };
    const getStack = bone => {
        const stack = Array.isArray(bone && bone.ef_constraints) ? bone.ef_constraints : [];
        stack.forEach(constraint => {
            normalizeDistanceConstraint(constraint);
            normalizeCopyConstraint(constraint);
            normalizeArmatureBlend(constraint);
            normalizeActionConstraint(constraint);
            normalizeFloorDrop(constraint);
            normalizeShrinkwrap(constraint);
            normalizeFollowPath(constraint);
        });
        return stack;
    };
    const safeChannelId = value => String(value).replace(/[^a-zA-Z0-9_]/g, '_');
    const getInfluenceChannel = constraint => 'ef_influence_' + safeChannelId(constraint.id);
    const getPathProgressChannel = constraint => 'ef_path_progress_' + safeChannelId(constraint.id);
    const getArmatureWeightChannel = (constraint, entry) => 'ef_armature_weight_' + safeChannelId(constraint.id) + '_' + safeChannelId(entry.id);
    const getSpaceWeightChannel = (constraint, entry) => 'ef_space_weight_' + safeChannelId(constraint.id) + '_' + safeChannelId(entry.id);
    const ensureArmatureWeightChannel = (animator, constraint, entry) => {
        const channel = getArmatureWeightChannel(constraint, entry);
        if (animatorPrototype && !animatorPrototype.channels[channel]) animatorPrototype.channels[channel] = {name: tl('ef.constraint.armature_blend') + ' · ' + ((findNode(entry.target) || {}).name || tl('ef.constraint.armature_entry')), mutable: true, transform: true, max_data_points: 1};
        if (animator && !Array.isArray(animator[channel])) animator[channel] = [];
        return channel;
    };
    const ensurePathProgressChannel = (animator, constraint) => {
        const channel = getPathProgressChannel(constraint);
        if (animatorPrototype && !animatorPrototype.channels[channel]) animatorPrototype.channels[channel] = {name: tl('ef.constraint.progress') + ' · ' + constraint.name, mutable: true, transform: true, max_data_points: 1};
        if (animator && !Array.isArray(animator[channel])) animator[channel] = [];
        return channel;
    };
    const ensureSpaceWeightChannel = (animator, constraint, entry) => {
        const channel = getSpaceWeightChannel(constraint, entry);
        if (animatorPrototype && !animatorPrototype.channels[channel]) animatorPrototype.channels[channel] = {name: tl('ef.constraint.space_switch') + ' · ' + (findNode(entry.target) || {}).name, mutable: true, transform: true, max_data_points: 1};
        if (animator && !Array.isArray(animator[channel])) animator[channel] = [];
        return channel;
    };
    const ensureInfluenceChannel = (animator, constraint) => {
        const channel = getInfluenceChannel(constraint);
        if (animatorPrototype && !animatorPrototype.channels[channel]) {
            animatorPrototype.channels[channel] = {name: tl('ef.ik.influence') + ' · ' + constraint.name, mutable: true, transform: true, max_data_points: 1};
        }
        if (animator && !Array.isArray(animator[channel])) {
            animator[channel] = Array.isArray(animator.influence)
                ? animator.influence.filter(keyframe => keyframe.ef_constraint_id === constraint.id)
                : [];
            animator[channel].forEach(keyframe => keyframe.channel = channel);
            if (animator[channel].length) animator.influence = animator.influence.filter(keyframe => keyframe.ef_constraint_id !== constraint.id);
        }
        return channel;
    };
    ArmatureBone.all.forEach(bone => getStack(bone).forEach(constraint => {
        ensureInfluenceChannel(null, constraint);
        if (constraint.type === 'follow_path') ensurePathProgressChannel(null, constraint);
        if (constraint.type === 'armature_blend' && Array.isArray(constraint.entries)) constraint.entries.forEach(entry => ensureArmatureWeightChannel(null, constraint, entry));
        if (constraint.type === 'space_switch' && Array.isArray(constraint.entries)) constraint.entries.forEach(entry => ensureSpaceWeightChannel(null, constraint, entry));
    }));
    const getPathProgressKeyframes = (bone, constraint) => {
        const animation = typeof Animation !== 'undefined' && Animation.selected;
        const animator = animation && animation.animators && animation.animators[bone.uuid];
        const channel = ensurePathProgressChannel(animator, constraint);
        return animator && Array.isArray(animator[channel]) ? animator[channel] : [];
    };
    const getInfluenceKeyframes = (bone, constraint) => {
        const animation = typeof Animation !== 'undefined' && Animation.selected;
        const animator = animation && animation.animators && animation.animators[bone.uuid];
        const channel = ensureInfluenceChannel(animator, constraint);
        return animator && Array.isArray(animator[channel]) ? animator[channel] : [];
    };
    const getArmatureWeightKeyframes = (bone, constraint, entry) => {
        const animation = typeof Animation !== 'undefined' && Animation.selected;
        const animator = animation && animation.animators && animation.animators[bone.uuid];
        const channel = ensureArmatureWeightChannel(animator, constraint, entry);
        return animator && Array.isArray(animator[channel]) ? animator[channel] : [];
    };
    const getConstraintKeyframesAcrossAnimations = (bone, constraint, entries) => {
        const animations = typeof Animation !== 'undefined' && Array.isArray(Animation.all) ? Animation.all : [];
        const keyframes = [];
        animations.forEach(animation => {
            const animator = animation.animators && animation.animators[bone.uuid];
            if (!animator) return;
            const influenceChannel = ensureInfluenceChannel(animator, constraint);
            if (Array.isArray(animator[influenceChannel])) keyframes.push(...animator[influenceChannel]);
            (entries || []).forEach(entry => {
                const weightChannel = ensureArmatureWeightChannel(animator, constraint, entry);
                if (Array.isArray(animator[weightChannel])) keyframes.push(...animator[weightChannel]);
            });
        });
        return {animations, keyframes: [...new Set(keyframes)]};
    };
    const getSpaceWeightKeyframes = (bone, constraint, entry) => {
        const animation = typeof Animation !== 'undefined' && Animation.selected;
        const animator = animation && animation.animators && animation.animators[bone.uuid];
        const channel = ensureSpaceWeightChannel(animator, constraint, entry);
        return animator && Array.isArray(animator[channel]) ? animator[channel] : [];
    };
    const armatureWeightAt = (bone, constraint, entry) => {
        const baseValue = Number(entry.weight);
        const base = THREE.MathUtils.clamp(Number.isFinite(baseValue) ? baseValue : 0, 0, 1);
        const animator = Animation.selected && Animation.selected.animators && Animation.selected.animators[bone.uuid];
        if (!animator) return base;
        const channel = ensureArmatureWeightChannel(animator, constraint, entry);
        if (!animator[channel].length) return base;
        const interpolated = animator.interpolate(channel, false);
        const value = Array.isArray(interpolated) ? interpolated[0] : interpolated;
        return THREE.MathUtils.clamp(Number(value), 0, 1);
    };
    const spaceWeightAt = (bone, constraint, entry) => {
        const baseValue = Number(entry.weight);
        const base = THREE.MathUtils.clamp(Number.isFinite(baseValue) ? baseValue : 0, 0, 1);
        const animator = Animation.selected && Animation.selected.animators && Animation.selected.animators[bone.uuid];
        if (!animator) return base;
        const channel = ensureSpaceWeightChannel(animator, constraint, entry);
        if (!animator[channel].length) return base;
        const interpolated = animator.interpolate(channel, false);
        const value = Array.isArray(interpolated) ? interpolated[0] : interpolated;
        return THREE.MathUtils.clamp(Number(value), 0, 1);
    };
    const pathProgressAt = (bone, constraint) => {
        const baseValue = Number(constraint.progress);
        const base = THREE.MathUtils.clamp(Number.isFinite(baseValue) ? baseValue : 0, 0, 1);
        const animator = Animation.selected && Animation.selected.animators && Animation.selected.animators[bone.uuid];
        if (!animator) return base;
        const channel = ensurePathProgressChannel(animator, constraint);
        if (!animator[channel].length) return base;
        const interpolated = animator.interpolate(channel, false);
        const value = Array.isArray(interpolated) ? interpolated[0] : interpolated;
        return THREE.MathUtils.clamp(Number(value), 0, 1);
    };
    const influenceAt = (bone, constraint) => {
        const base = THREE.MathUtils.clamp(Number(constraint.influence), 0, 1);
        const animator = Animation.selected && Animation.selected.animators && Animation.selected.animators[bone.uuid];
        if (!animator) return base;
        const channel = ensureInfluenceChannel(animator, constraint);
        if (!animator[channel].length) return base;
        const interpolated = animator.interpolate(channel, false);
        const value = Array.isArray(interpolated) ? interpolated[0] : interpolated;
        return THREE.MathUtils.clamp(Number(value), 0, 1);
    };
    const decompose = matrix => {
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        matrix.decompose(position, quaternion, scale);
        return {position, quaternion, scale};
    };
    const compose = value => new THREE.Matrix4().compose(value.position, value.quaternion, value.scale);
    const blendTransform = (current, target, influence, axes) => {
        const result = {
            position: current.position.clone(),
            quaternion: current.quaternion.clone(),
            scale: current.scale.clone()
        };
        const usePosition = !axes || axes.position !== false;
        const useRotation = !axes || axes.rotation !== false;
        const useScale = !axes || axes.scale !== false;
        if (usePosition) ['x', 'y', 'z'].forEach(axis => {
            if (!axes || !axes.position_axes || axes.position_axes[axis] !== false) result.position[axis] = THREE.MathUtils.lerp(current.position[axis], target.position[axis], influence);
        });
        if (useRotation) {
            const order = Format.euler_order || 'ZYX';
            const currentEuler = new THREE.Euler().setFromQuaternion(current.quaternion, order);
            const targetEuler = new THREE.Euler().setFromQuaternion(target.quaternion, order);
            ['x', 'y', 'z'].forEach(axis => {
                if (!axes || !axes.rotation_axes || axes.rotation_axes[axis] !== false) currentEuler[axis] = THREE.MathUtils.lerp(currentEuler[axis], targetEuler[axis], influence);
            });
            result.quaternion.setFromEuler(currentEuler);
        }
        if (useScale) ['x', 'y', 'z'].forEach(axis => {
            if (!axes || !axes.scale_axes || axes.scale_axes[axis] !== false) result.scale[axis] = THREE.MathUtils.lerp(current.scale[axis], target.scale[axis], influence);
        });
        return result;
    };
    const localFromWorld = (bone, worldMatrix) => bone.mesh.parent ? bone.mesh.parent.matrixWorld.clone().invert().multiply(worldMatrix) : worldMatrix.clone();
    const targetLocal = (bone, target, space) => {
        target.mesh.updateMatrixWorld(true);
        if (space === 'local') return target.mesh.matrix.clone();
        return localFromWorld(bone, target.mesh.matrixWorld);
    };
    const transformInSpace = (node, space) => {
        node.mesh.updateMatrixWorld(true);
        return decompose(space === 'world' ? node.mesh.matrixWorld : node.mesh.matrix);
    };
    const channelValues = (transform, channel) => {
        if (channel === 'position') return transform.position.toArray();
        if (channel === 'scale') return transform.scale.toArray();
        const euler = new THREE.Euler().setFromQuaternion(transform.quaternion, Format.euler_order || 'ZYX');
        return [Math.radToDeg(euler.x), Math.radToDeg(euler.y), Math.radToDeg(euler.z)];
    };
    const setChannelValues = (transform, channel, values) => {
        if (channel === 'position') transform.position.fromArray(values);
        else if (channel === 'scale') transform.scale.fromArray(values);
        else transform.quaternion.setFromEuler(new THREE.Euler(Math.degToRad(values[0]), Math.degToRad(values[1]), Math.degToRad(values[2]), Format.euler_order || 'ZYX'));
    };
    const applyTransformMapping = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        const sourceChannel = ['position', 'rotation', 'scale'].includes(constraint.source_channel) ? constraint.source_channel : 'position';
        const targetChannel = ['position', 'rotation', 'scale'].includes(constraint.target_channel) ? constraint.target_channel : 'position';
        const source = channelValues(transformInSpace(target, constraint.source_space === 'world' ? 'world' : 'local'), sourceChannel);
        const axes = Array.isArray(constraint.axis_mapping) ? constraint.axis_mapping : [0, 1, 2];
        const fromMin = Array.isArray(constraint.from_min) ? constraint.from_min : [0, 0, 0];
        const fromMax = Array.isArray(constraint.from_max) ? constraint.from_max : [1, 1, 1];
        const toMin = Array.isArray(constraint.to_min) ? constraint.to_min : [0, 0, 0];
        const toMax = Array.isArray(constraint.to_max) ? constraint.to_max : [1, 1, 1];
        const mapped = [0, 1, 2].map(axis => {
            const sourceAxis = THREE.MathUtils.clamp(Math.floor(Number(axes[axis]) || 0), 0, 2);
            const low = Number(fromMin[axis]);
            const high = Number(fromMax[axis]);
            const start = Number(toMin[axis]);
            const end = Number(toMax[axis]);
            const denominator = high - low;
            let factor = Math.abs(denominator) > 1e-8 ? (source[sourceAxis] - low) / denominator : 0;
            if (constraint.extrapolate !== true) factor = THREE.MathUtils.clamp(factor, 0, 1);
            return THREE.MathUtils.lerp(Number.isFinite(start) ? start : 0, Number.isFinite(end) ? end : 0, factor);
        });
        const targetSpace = constraint.target_space === 'world' ? 'world' : 'local';
        const currentSpace = transformInSpace(bone, targetSpace);
        const currentValues = channelValues(currentSpace, targetChannel);
        const mode = ['replace', 'add', 'multiply'].includes(constraint.mix_mode) ? constraint.mix_mode : 'replace';
        const desiredValues = mapped.map((value, axis) => mode === 'add' ? currentValues[axis] + value : mode === 'multiply' ? currentValues[axis] * value : value);
        const blendedValues = currentValues.map((value, axis) => THREE.MathUtils.lerp(value, desiredValues[axis], influence));
        setChannelValues(currentSpace, targetChannel, blendedValues);
        const localMatrix = targetSpace === 'world' ? localFromWorld(bone, compose(currentSpace)) : compose(currentSpace);
        bone.mesh.matrix.copy(localMatrix);
        bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
        bone.mesh.updateMatrixWorld(true);
    };
    const captureCopyChannelsOffset = (bone, constraint) => {
        const target = findNode(constraint.target);
        if (!bone || !bone.mesh || !target || !target.mesh || target === bone) {
            constraint.position_offset = [0, 0, 0];
            constraint.rotation_offset = [0, 0, 0, 1];
            constraint.scale_offset = [1, 1, 1];
            return;
        }
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        bone.mesh.updateMatrixWorld(true);
        const owner = decompose(bone.mesh.matrix);
        const source = decompose(targetLocal(bone, target, constraint.space));
        constraint.position_offset = owner.position.clone().sub(source.position).toArray();
        constraint.rotation_offset = source.quaternion.clone().invert().multiply(owner.quaternion).normalize().toArray();
        constraint.scale_offset = ['x', 'y', 'z'].map(axis => Math.abs(source.scale[axis]) > 1e-8 ? owner.scale[axis] / source.scale[axis] : 1);
    };
    const applyCopyChannels = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        const current = decompose(bone.mesh.matrix);
        const source = decompose(targetLocal(bone, target, constraint.space));
        const axes = constraint.axes || {};
        if (constraint.maintain_offset) {
            if (!Array.isArray(constraint.position_offset) || constraint.position_offset.length !== 3 || !Array.isArray(constraint.rotation_offset) || constraint.rotation_offset.length !== 4 || !Array.isArray(constraint.scale_offset) || constraint.scale_offset.length !== 3) captureCopyChannelsOffset(bone, constraint);
            if (axes.position !== false) source.position.add(new THREE.Vector3().fromArray(constraint.position_offset));
            if (axes.rotation !== false) source.quaternion.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset)).normalize();
            if (axes.scale !== false) ['x', 'y', 'z'].forEach((axis, index) => {
                const offset = Number(constraint.scale_offset[index]);
                source.scale[axis] = Number.isFinite(offset) ? source.scale[axis] * offset : current.scale[axis];
            });
        }
        const blended = blendTransform(current, source, influence, axes);
        if (axes.rotation === false) blended.quaternion.copy(current.quaternion);
        bone.mesh.matrix.copy(compose(blended));
        bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
        bone.mesh.updateMatrixWorld(true);
    };
    const copyTransformSourceMatrix = (target, constraint) => {
        target.mesh.updateMatrixWorld(true);
        return (constraint.source_space === 'local' ? target.mesh.matrix : target.mesh.matrixWorld).clone();
    };
    const copyTransformOwnerMatrix = (bone, constraint) => {
        bone.mesh.updateMatrixWorld(true);
        return (constraint.target_space === 'world' ? bone.mesh.matrixWorld : bone.mesh.matrix).clone();
    };
    const captureCopyTransformOffset = (bone, constraint) => {
        const target = findNode(constraint.target);
        if (!bone || !bone.mesh || !target || !target.mesh || target === bone) {
            constraint.offset_matrix = new THREE.Matrix4().toArray();
            return;
        }
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        const source = copyTransformSourceMatrix(target, constraint);
        const owner = copyTransformOwnerMatrix(bone, constraint);
        constraint.offset_matrix = source.invert().multiply(owner).toArray();
    };
    const filteredCopyTransformSource = (matrix, constraint) => {
        const source = decompose(matrix);
        const channels = constraint.channels || {};
        const positionAxes = constraint.position_axes || {};
        const rotationAxes = constraint.rotation_axes || {};
        const scaleAxes = constraint.scale_axes || {};
        if (channels.position === false) source.position.set(0, 0, 0);
        else ['x', 'y', 'z'].forEach(axis => { if (positionAxes[axis] === false) source.position[axis] = 0; });
        const euler = new THREE.Euler().setFromQuaternion(source.quaternion, Format.euler_order || 'ZYX');
        if (channels.rotation === false) euler.set(0, 0, 0, Format.euler_order || 'ZYX');
        else ['x', 'y', 'z'].forEach(axis => { if (rotationAxes[axis] === false) euler[axis] = 0; });
        source.quaternion.setFromEuler(euler).normalize();
        if (channels.scale === false) source.scale.set(1, 1, 1);
        else ['x', 'y', 'z'].forEach(axis => { if (scaleAxes[axis] === false) source.scale[axis] = 1; });
        return compose(source);
    };
    const applyCopyTransform = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        const ownerMatrix = copyTransformOwnerMatrix(bone, constraint);
        let sourceMatrix = copyTransformSourceMatrix(target, constraint);
        if (constraint.maintain_offset === true) {
            if (!Array.isArray(constraint.offset_matrix) || constraint.offset_matrix.length !== 16) captureCopyTransformOffset(bone, constraint);
            sourceMatrix.multiply(new THREE.Matrix4().fromArray(constraint.offset_matrix));
        }
        const mode = ['replace', 'before', 'after'].includes(constraint.mix_mode) ? constraint.mix_mode : 'replace';
        let desired;
        if (mode === 'before') desired = filteredCopyTransformSource(sourceMatrix, constraint).multiply(ownerMatrix);
        else if (mode === 'after') desired = ownerMatrix.clone().multiply(filteredCopyTransformSource(sourceMatrix, constraint));
        else {
            const current = decompose(ownerMatrix);
            const source = decompose(sourceMatrix);
            const channels = constraint.channels || {};
            const positionAxes = constraint.position_axes || {};
            const rotationAxes = constraint.rotation_axes || {};
            const scaleAxes = constraint.scale_axes || {};
            if (channels.position !== false) ['x', 'y', 'z'].forEach(axis => { if (positionAxes[axis] !== false) current.position[axis] = source.position[axis]; });
            if (channels.rotation !== false) {
                const order = Format.euler_order || 'ZYX';
                const currentEuler = new THREE.Euler().setFromQuaternion(current.quaternion, order);
                const sourceEuler = new THREE.Euler().setFromQuaternion(source.quaternion, order);
                ['x', 'y', 'z'].forEach(axis => { if (rotationAxes[axis] !== false) currentEuler[axis] = sourceEuler[axis]; });
                current.quaternion.setFromEuler(currentEuler).normalize();
            }
            if (channels.scale !== false) ['x', 'y', 'z'].forEach(axis => { if (scaleAxes[axis] !== false) current.scale[axis] = source.scale[axis]; });
            desired = compose(current);
        }
        const current = decompose(ownerMatrix);
        const targetTransform = decompose(desired);
        const channels = constraint.channels || {};
        const positionAxes = constraint.position_axes || {};
        const rotationAxes = constraint.rotation_axes || {};
        const scaleAxes = constraint.scale_axes || {};
        if (channels.position !== false) ['x', 'y', 'z'].forEach(axis => { if (positionAxes[axis] !== false) current.position[axis] = THREE.MathUtils.lerp(current.position[axis], targetTransform.position[axis], influence); });
        if (channels.rotation !== false) {
            const order = Format.euler_order || 'ZYX';
            const currentEuler = new THREE.Euler().setFromQuaternion(current.quaternion, order);
            const targetEuler = new THREE.Euler().setFromQuaternion(targetTransform.quaternion, order);
            ['x', 'y', 'z'].forEach(axis => { if (rotationAxes[axis] === false) targetEuler[axis] = currentEuler[axis]; });
            current.quaternion.slerp(new THREE.Quaternion().setFromEuler(targetEuler), influence).normalize();
        }
        if (channels.scale !== false) ['x', 'y', 'z'].forEach(axis => { if (scaleAxes[axis] !== false) current.scale[axis] = THREE.MathUtils.lerp(current.scale[axis], targetTransform.scale[axis], influence); });
        const resultMatrix = compose(current);
        const localMatrix = constraint.target_space === 'world' ? localFromWorld(bone, resultMatrix) : resultMatrix;
        bone.mesh.matrix.copy(localMatrix);
        bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
        bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
        bone.mesh.updateMatrixWorld(true);
    };
    const positionInSpace = (node, space) => {
        node.mesh.updateMatrixWorld(true);
        return space === 'world' ? node.mesh.getWorldPosition(new THREE.Vector3()) : node.mesh.position.clone();
    };
    const positionBlendSource = (target, space, invert) => {
        const source = positionInSpace(target, space === 'local' ? 'local' : 'world');
        return invert === true ? source.negate() : source;
    };
    const positionBlendDesired = constraint => {
        const targetA = findNode(constraint.target_a);
        const targetB = findNode(constraint.target_b);
        if (!targetA || !targetA.mesh || !targetB || !targetB.mesh) return null;
        const sourceA = positionBlendSource(targetA, constraint.source_space_a, constraint.invert_target_a);
        const sourceB = positionBlendSource(targetB, constraint.source_space_b, constraint.invert_target_b);
        const weightValue = Number(constraint.blend_weight);
        const weight = THREE.MathUtils.clamp(Number.isFinite(weightValue) ? weightValue : 0.5, 0, 1);
        return sourceA.lerp(sourceB, weight);
    };
    const capturePositionBlendOffset = (bone, constraint) => {
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        const desired = bone && bone.mesh ? positionBlendDesired(constraint) : null;
        if (!desired) {
            constraint.position_offset = [0, 0, 0];
            return;
        }
        const owner = positionInSpace(bone, constraint.target_space === 'local' ? 'local' : 'world');
        constraint.position_offset = owner.sub(desired).toArray();
    };
    const applyPositionBlend = (bone, constraint, influence) => {
        const targetA = findNode(constraint.target_a);
        const targetB = findNode(constraint.target_b);
        if (!targetA || !targetA.mesh || targetA === bone || !targetB || !targetB.mesh || targetB === bone) return;
        const targetSpace = constraint.target_space === 'local' ? 'local' : 'world';
        const current = positionInSpace(bone, targetSpace);
        const desired = positionBlendDesired(constraint);
        if (!desired) return;
        if (constraint.maintain_offset === true) {
            if (!Array.isArray(constraint.position_offset) || constraint.position_offset.length !== 3) capturePositionBlendOffset(bone, constraint);
            desired.add(new THREE.Vector3().fromArray(constraint.position_offset));
        }
        const enabledAxes = constraint.position_axes || {};
        const result = current.clone();
        ['x', 'y', 'z'].forEach(axis => {
            if (enabledAxes[axis] !== false) result[axis] = THREE.MathUtils.lerp(current[axis], desired[axis], influence);
        });
        const local = targetSpace === 'world' && bone.mesh.parent ? bone.mesh.parent.worldToLocal(result.clone()) : result;
        bone.mesh.position.copy(local);
        bone.mesh.updateMatrixWorld(true);
    };
    const scaleBlendEpsilon = 1e-8;
    const scaleInSpace = (node, space) => {
        node.mesh.updateMatrixWorld(true);
        return decompose(space === 'world' ? node.mesh.matrixWorld : node.mesh.matrix).scale;
    };
    const safeScaleDenominator = value => {
        const number = Number(value);
        if (!Number.isFinite(number)) return 1;
        if (Math.abs(number) >= scaleBlendEpsilon) return number;
        return number < 0 ? -scaleBlendEpsilon : scaleBlendEpsilon;
    };
    const scaleBlendSource = (target, space, reciprocal) => {
        const source = scaleInSpace(target, space === 'local' ? 'local' : 'world');
        if (reciprocal === true) ['x', 'y', 'z'].forEach(axis => source[axis] = 1 / safeScaleDenominator(source[axis]));
        return source;
    };
    const logarithmicScaleBlend = (a, b, weight) => {
        if (weight <= 0) return a;
        if (weight >= 1) return b;
        const magnitude = Math.exp(THREE.MathUtils.lerp(Math.log(Math.max(Math.abs(a), scaleBlendEpsilon)), Math.log(Math.max(Math.abs(b), scaleBlendEpsilon)), weight));
        const dominant = weight < 0.5 ? a : b;
        return (dominant < 0 ? -1 : 1) * magnitude;
    };
    const scaleBlendDesired = constraint => {
        const targetA = findNode(constraint.target_a);
        const targetB = findNode(constraint.target_b);
        if (!targetA || !targetA.mesh || !targetB || !targetB.mesh) return null;
        const sourceA = scaleBlendSource(targetA, constraint.source_space_a, constraint.reciprocal_target_a);
        const sourceB = scaleBlendSource(targetB, constraint.source_space_b, constraint.reciprocal_target_b);
        const weightValue = Number(constraint.blend_weight);
        const weight = THREE.MathUtils.clamp(Number.isFinite(weightValue) ? weightValue : 0.5, 0, 1);
        const logarithmic = constraint.mix_mode === 'logarithmic';
        return new THREE.Vector3(...['x', 'y', 'z'].map(axis => logarithmic ? logarithmicScaleBlend(sourceA[axis], sourceB[axis], weight) : THREE.MathUtils.lerp(sourceA[axis], sourceB[axis], weight)));
    };
    const captureScaleBlendOffset = (bone, constraint) => {
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        const desired = bone && bone.mesh ? scaleBlendDesired(constraint) : null;
        if (!desired) {
            constraint.scale_offset = [1, 1, 1];
            return;
        }
        const owner = scaleInSpace(bone, constraint.target_space === 'world' ? 'world' : 'local');
        constraint.scale_offset = ['x', 'y', 'z'].map(axis => owner[axis] / safeScaleDenominator(desired[axis]));
    };
    const applyScaleBlend = (bone, constraint, influence) => {
        const targetA = findNode(constraint.target_a);
        const targetB = findNode(constraint.target_b);
        if (!targetA || !targetA.mesh || targetA === bone || !targetB || !targetB.mesh || targetB === bone) return;
        const targetSpace = constraint.target_space === 'world' ? 'world' : 'local';
        const currentTransform = transformInSpace(bone, targetSpace);
        const desired = scaleBlendDesired(constraint);
        if (!desired) return;
        if (constraint.maintain_offset === true) {
            if (!Array.isArray(constraint.scale_offset) || constraint.scale_offset.length !== 3) captureScaleBlendOffset(bone, constraint);
            ['x', 'y', 'z'].forEach((axis, index) => {
                const ratio = Number(constraint.scale_offset[index]);
                desired[axis] *= Number.isFinite(ratio) ? ratio : 1;
            });
        }
        const enabledAxes = constraint.scale_axes || {};
        ['x', 'y', 'z'].forEach(axis => {
            if (enabledAxes[axis] !== false) currentTransform.scale[axis] = THREE.MathUtils.lerp(currentTransform.scale[axis], desired[axis], influence);
        });
        const localMatrix = targetSpace === 'world' ? localFromWorld(bone, compose(currentTransform)) : compose(currentTransform);
        bone.mesh.matrix.copy(localMatrix);
        bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
        bone.mesh.updateMatrixWorld(true);
    };
    const quaternionInSpace = (node, space) => {
        node.mesh.updateMatrixWorld(true);
        return (space === 'world' ? node.mesh.getWorldQuaternion(new THREE.Quaternion()) : node.mesh.quaternion.clone()).normalize();
    };
    const copyQuaternionSource = (target, constraint) => {
        const source = quaternionInSpace(target, constraint.source_space === 'world' ? 'world' : 'local');
        return constraint.invert_target === true ? source.invert().normalize() : source;
    };
    const captureQuaternionOffset = (bone, constraint) => {
        const target = findNode(constraint.target);
        if (!bone || !bone.mesh || !target || !target.mesh || target === bone) {
            constraint.rotation_offset = [0, 0, 0, 1];
            return;
        }
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        const source = copyQuaternionSource(target, constraint);
        const owner = quaternionInSpace(bone, constraint.target_space === 'world' ? 'world' : 'local');
        constraint.rotation_offset = source.clone().invert().multiply(owner).normalize().toArray();
    };
    const nlerpQuaternion = (current, target, influence) => {
        const adjusted = target.clone();
        if (current.dot(adjusted) < 0) adjusted.set(-adjusted.x, -adjusted.y, -adjusted.z, -adjusted.w);
        return new THREE.Quaternion(
            THREE.MathUtils.lerp(current.x, adjusted.x, influence),
            THREE.MathUtils.lerp(current.y, adjusted.y, influence),
            THREE.MathUtils.lerp(current.z, adjusted.z, influence),
            THREE.MathUtils.lerp(current.w, adjusted.w, influence)
        ).normalize();
    };
    const applyCopyQuaternion = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        const targetSpace = constraint.target_space === 'world' ? 'world' : 'local';
        const current = quaternionInSpace(bone, targetSpace);
        const desired = copyQuaternionSource(target, constraint);
        if (constraint.maintain_offset === true) {
            if (!Array.isArray(constraint.rotation_offset) || constraint.rotation_offset.length !== 4) captureQuaternionOffset(bone, constraint);
            desired.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset)).normalize();
        }
        const blended = constraint.mix_mode === 'nlerp'
            ? nlerpQuaternion(current, desired, influence)
            : current.clone().slerp(desired, influence).normalize();
        const local = targetSpace === 'world' && bone.mesh.parent
            ? bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(blended).normalize()
            : blended;
        bone.mesh.quaternion.copy(local);
        bone.mesh.rotation.setFromQuaternion(local, Format.euler_order || 'ZYX');
        bone.mesh.updateMatrixWorld(true);
    };
    const rotationBlendSource = (target, space, invert) => {
        const source = quaternionInSpace(target, space === 'local' ? 'local' : 'world');
        return invert === true ? source.invert().normalize() : source;
    };
    const rotationBlendDesired = constraint => {
        const targetA = findNode(constraint.target_a);
        const targetB = findNode(constraint.target_b);
        if (!targetA || !targetA.mesh || !targetB || !targetB.mesh) return null;
        const sourceA = rotationBlendSource(targetA, constraint.source_space_a, constraint.invert_target_a);
        const sourceB = rotationBlendSource(targetB, constraint.source_space_b, constraint.invert_target_b);
        const weight = THREE.MathUtils.clamp(Number(constraint.blend_weight), 0, 1);
        return constraint.mix_mode === 'nlerp'
            ? nlerpQuaternion(sourceA, sourceB, weight)
            : sourceA.clone().slerp(sourceB, weight).normalize();
    };
    const rotationDifferenceValue = constraint => {
        const targetA = findNode(constraint.target_a);
        const targetB = findNode(constraint.target_b);
        if (!targetA || !targetA.mesh || !targetB || !targetB.mesh) return null;
        const sourceA = quaternionInSpace(targetA, constraint.source_space_a === 'world' ? 'world' : 'local');
        const sourceB = quaternionInSpace(targetB, constraint.source_space_b === 'world' ? 'world' : 'local');
        return constraint.direction === 'b_to_a'
            ? sourceB.invert().multiply(sourceA).normalize()
            : sourceA.invert().multiply(sourceB).normalize();
    };
    const rotationDifferenceDesired = (bone, constraint) => {
        const rawDifference = rotationDifferenceValue(constraint);
        if (!rawDifference) return null;
        const strengthValue = Number(constraint.difference_strength);
        const strength = THREE.MathUtils.clamp(Number.isFinite(strengthValue) ? strengthValue : 1, 0, 1);
        const difference = new THREE.Quaternion().slerp(rawDifference, strength).normalize();
        const targetSpace = constraint.target_space === 'world' ? 'world' : 'local';
        const current = quaternionInSpace(bone, targetSpace);
        return constraint.application_mode === 'replace' ? difference : current.multiply(difference).normalize();
    };
    const captureRotationDifferenceOffset = (bone, constraint) => {
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        const desired = bone && bone.mesh ? rotationDifferenceDesired(bone, constraint) : null;
        if (!desired) {
            constraint.rotation_offset = [0, 0, 0, 1];
            return;
        }
        const owner = quaternionInSpace(bone, constraint.target_space === 'world' ? 'world' : 'local');
        constraint.rotation_offset = desired.invert().multiply(owner).normalize().toArray();
    };
    const applyRotationDifference = (bone, constraint, influence) => {
        const targetA = findNode(constraint.target_a);
        const targetB = findNode(constraint.target_b);
        if (!targetA || !targetA.mesh || targetA === bone || !targetB || !targetB.mesh || targetB === bone) return;
        const targetSpace = constraint.target_space === 'world' ? 'world' : 'local';
        const current = quaternionInSpace(bone, targetSpace);
        const desired = rotationDifferenceDesired(bone, constraint);
        if (!desired) return;
        if (constraint.maintain_offset === true) {
            if (!Array.isArray(constraint.rotation_offset) || constraint.rotation_offset.length !== 4) captureRotationDifferenceOffset(bone, constraint);
            desired.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset)).normalize();
        }
        const result = current.clone().slerp(desired, influence).normalize();
        const local = targetSpace === 'world' && bone.mesh.parent
            ? bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(result).normalize()
            : result;
        bone.mesh.quaternion.copy(local);
        bone.mesh.rotation.setFromQuaternion(local, Format.euler_order || 'ZYX');
        bone.mesh.updateMatrixWorld(true);
    };
    const captureRotationBlendOffset = (bone, constraint) => {
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        const desired = bone && bone.mesh ? rotationBlendDesired(constraint) : null;
        if (!desired) {
            constraint.rotation_offset = [0, 0, 0, 1];
            return;
        }
        const owner = quaternionInSpace(bone, constraint.target_space === 'local' ? 'local' : 'world');
        constraint.rotation_offset = desired.clone().invert().multiply(owner).normalize().toArray();
    };
    const applyRotationBlend = (bone, constraint, influence) => {
        const targetA = findNode(constraint.target_a);
        const targetB = findNode(constraint.target_b);
        if (!targetA || !targetA.mesh || targetA === bone || !targetB || !targetB.mesh || targetB === bone) return;
        const targetSpace = constraint.target_space === 'local' ? 'local' : 'world';
        const current = quaternionInSpace(bone, targetSpace);
        const desired = rotationBlendDesired(constraint);
        if (!desired) return;
        if (constraint.maintain_offset === true) {
            if (!Array.isArray(constraint.rotation_offset) || constraint.rotation_offset.length !== 4) captureRotationBlendOffset(bone, constraint);
            desired.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset)).normalize();
        }
        const result = current.clone().slerp(desired, influence).normalize();
        const local = targetSpace === 'world' && bone.mesh.parent
            ? bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(result).normalize()
            : result;
        bone.mesh.quaternion.copy(local);
        bone.mesh.rotation.setFromQuaternion(local, Format.euler_order || 'ZYX');
        bone.mesh.updateMatrixWorld(true);
    };
    const applyLimit = (bone, constraint, influence) => {
        const current = decompose(bone.mesh.matrix);
        const limited = {position: current.position.clone(), quaternion: current.quaternion.clone(), scale: current.scale.clone()};
        const order = Format.euler_order || 'ZYX';
        const euler = new THREE.Euler().setFromQuaternion(current.quaternion, order);
        const rotation = [Math.radToDeg(euler.x), Math.radToDeg(euler.y), Math.radToDeg(euler.z)];
        const clampVector = (values, min, max, enabled) => values.map((value, index) => enabled && enabled[index] !== false ? THREE.MathUtils.clamp(value, Number(min[index]), Number(max[index])) : value);
        const position = clampVector(current.position.toArray(), constraint.position_min || [-Infinity, -Infinity, -Infinity], constraint.position_max || [Infinity, Infinity, Infinity], constraint.position_axes || [true, true, true]);
        const rotationLimited = clampVector(rotation, constraint.rotation_min || [-180, -180, -180], constraint.rotation_max || [180, 180, 180], constraint.rotation_axes || [true, true, true]);
        const scale = clampVector(current.scale.toArray(), constraint.scale_min || [0, 0, 0], constraint.scale_max || [100, 100, 100], constraint.scale_axes || [true, true, true]);
        limited.position.lerp(new THREE.Vector3().fromArray(position), influence);
        limited.quaternion.slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.degToRad(rotationLimited[0]), Math.degToRad(rotationLimited[1]), Math.degToRad(rotationLimited[2]), order)), influence);
        limited.scale.lerp(new THREE.Vector3().fromArray(scale), influence);
        bone.mesh.matrix.copy(compose(limited));
        bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
        bone.mesh.updateMatrixWorld(true);
    };
    const constraintAxis = (target, axisName, space) => {
        const negative = String(axisName || '').startsWith('-');
        const axis = String(axisName || 'y').replace('-', '').toLowerCase();
        const vector = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
        if (space === 'target' && target && target.mesh) vector.applyQuaternion(target.mesh.getWorldQuaternion(new THREE.Quaternion()).normalize());
        if (negative) vector.negate();
        return vector.normalize();
    };
    const applyFloor = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        target.mesh.updateMatrixWorld(true);
        bone.mesh.updateMatrixWorld(true);
        const normal = constraintAxis(target, constraint.axis, constraint.space);
        const planePoint = target.mesh.getWorldPosition(new THREE.Vector3()).addScaledVector(normal, Number(constraint.offset) || 0);
        const currentWorld = bone.mesh.getWorldPosition(new THREE.Vector3());
        const distance = currentWorld.clone().sub(planePoint).dot(normal);
        if (constraint.prevent_penetration !== false && distance >= 0) return;
        const desiredWorld = currentWorld.clone().addScaledVector(normal, -distance);
        const blendedWorld = currentWorld.clone().lerp(desiredWorld, influence);
        const local = bone.mesh.parent ? bone.mesh.parent.worldToLocal(blendedWorld.clone()) : blendedWorld;
        bone.mesh.position.copy(local);
        bone.mesh.updateMatrixWorld(true);
    };
    const applyPivot = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        target.mesh.updateMatrixWorld(true);
        bone.mesh.updateMatrixWorld(true);
        const axis = constraintAxis(target, constraint.axis, constraint.space);
        const center = target.mesh.getWorldPosition(new THREE.Vector3());
        const currentWorld = bone.mesh.getWorldPosition(new THREE.Vector3());
        const relative = currentWorld.clone().sub(center);
        const axial = axis.clone().multiplyScalar(relative.dot(axis));
        const radial = relative.clone().sub(axial);
        const angle = Math.degToRad(Number(constraint.angle) || 0);
        const desiredWorld = constraint.keep_radius === false
            ? center.clone().add(axial)
            : center.clone().add(axial).add(radial.applyAxisAngle(axis, angle));
        const blendedWorld = currentWorld.clone().lerp(desiredWorld, influence);
        const local = bone.mesh.parent ? bone.mesh.parent.worldToLocal(blendedWorld.clone()) : blendedWorld;
        bone.mesh.position.copy(local);
        if (constraint.follow_rotation === true) {
            const delta = new THREE.Quaternion().setFromAxisAngle(axis, angle);
            const currentWorldQuaternion = bone.mesh.getWorldQuaternion(new THREE.Quaternion());
            const desiredWorldQuaternion = delta.multiply(currentWorldQuaternion);
            const parentWorldQuaternion = bone.mesh.parent ? bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
            const desiredLocalQuaternion = parentWorldQuaternion.invert().multiply(desiredWorldQuaternion);
            bone.mesh.quaternion.slerp(desiredLocalQuaternion, influence);
        }
        bone.mesh.updateMatrixWorld(true);
    };
    const axisVector = axisName => {
        const name = String(axisName || 'z').toLowerCase();
        const vector = name.includes('x') ? new THREE.Vector3(1, 0, 0) : name.includes('y') ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
        return name.startsWith('-') ? vector.negate() : vector;
    };
    const captureInitialDistance = (bone, constraint) => {
        const target = findNode(constraint.target);
        if (!bone || !bone.mesh || !target || !target.mesh || target === bone) {
            constraint.initial_distance = 0;
            return;
        }
        bone.mesh.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        constraint.initial_distance = bone.mesh.getWorldPosition(new THREE.Vector3()).distanceTo(target.mesh.getWorldPosition(new THREE.Vector3()));
    };
    const applyLimitDistance = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        normalizeDistanceConstraint(constraint);
        bone.mesh.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        const currentWorld = bone.mesh.getWorldPosition(new THREE.Vector3());
        const targetWorld = target.mesh.getWorldPosition(new THREE.Vector3());
        const currentDirection = currentWorld.clone().sub(targetWorld);
        const currentDistance = currentDirection.length();
        const limit = constraint.mode === 'initial' ? constraint.initial_distance : constraint.distance;
        let desiredDistance = currentDistance;
        if (constraint.mode === 'exact' || constraint.mode === 'initial') desiredDistance = limit;
        else if (constraint.mode === 'minimum' && currentDistance < limit) desiredDistance = limit;
        else if (constraint.mode === 'maximum' && currentDistance > limit) desiredDistance = limit;
        const violationDepth = Math.abs(currentDistance - desiredDistance);
        if (violationDepth <= 0) return;
        const normalizedDepth = constraint.softness > 0 ? THREE.MathUtils.clamp(violationDepth / constraint.softness, 0, 1) : 1;
        const softenedInfluence = normalizedDepth * normalizedDepth * (3 - 2 * normalizedDepth);
        const direction = currentDistance >= 1e-5 ? currentDirection.normalize() : new THREE.Vector3(1, 0, 0);
        const desiredWorld = targetWorld.clone().addScaledVector(direction, desiredDistance);
        const blendedWorld = currentWorld.lerp(desiredWorld, softenedInfluence * influence);
        const local = bone.mesh.parent ? bone.mesh.parent.worldToLocal(blendedWorld.clone()) : blendedWorld;
        bone.mesh.position.copy(local);
        bone.mesh.updateMatrixWorld(true);
    };
    const trackingDirection = (bone, target) => target.mesh.getWorldPosition(new THREE.Vector3()).sub(bone.mesh.getWorldPosition(new THREE.Vector3()));
    const trackingUp = (target, constraint) => {
        const up = new THREE.Vector3(0, 1, 0);
        return constraint.up_space === 'target' ? up.applyQuaternion(target.mesh.getWorldQuaternion(new THREE.Quaternion())).normalize() : up;
    };
    const orientAxes = (primaryLocal, secondaryLocal, primaryWorld, secondaryWorld) => {
        const primary = primaryWorld.clone().normalize();
        const localSecondary = secondaryLocal.clone().sub(primaryLocal.clone().multiplyScalar(secondaryLocal.dot(primaryLocal))).normalize();
        const desiredSecondary = secondaryWorld.clone().sub(primary.clone().multiplyScalar(secondaryWorld.dot(primary)));
        const fallback = Math.abs(primary.y) < 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        if (desiredSecondary.lengthSq() < 1e-10) desiredSecondary.copy(fallback).sub(primary.clone().multiplyScalar(fallback.dot(primary)));
        desiredSecondary.normalize();
        const swing = new THREE.Quaternion().setFromUnitVectors(primaryLocal.clone().normalize(), primary);
        const swungSecondary = localSecondary.applyQuaternion(swing).normalize();
        const angle = Math.atan2(primary.dot(swungSecondary.clone().cross(desiredSecondary)), THREE.MathUtils.clamp(swungSecondary.dot(desiredSecondary), -1, 1));
        return new THREE.Quaternion().setFromAxisAngle(primary, angle).multiply(swing).normalize();
    };
    const closestPointOnTriangle = (point, a, b, c) => {
        const ab = b.clone().sub(a);
        const ac = c.clone().sub(a);
        const ap = point.clone().sub(a);
        const d1 = ab.dot(ap);
        const d2 = ac.dot(ap);
        if (d1 <= 0 && d2 <= 0) return a.clone();
        const bp = point.clone().sub(b);
        const d3 = ab.dot(bp);
        const d4 = ac.dot(bp);
        if (d3 >= 0 && d4 <= d3) return b.clone();
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) return a.clone().addScaledVector(ab, d1 / (d1 - d3));
        const cp = point.clone().sub(c);
        const d5 = ab.dot(cp);
        const d6 = ac.dot(cp);
        if (d6 >= 0 && d5 <= d6) return c.clone();
        const vb = d5 * d2 - d1 * d6;
        if (vb <= 0 && d2 >= 0 && d6 <= 0) return a.clone().addScaledVector(ac, d2 / (d2 - d6));
        const va = d3 * d6 - d5 * d4;
        if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return b.clone().addScaledVector(c.clone().sub(b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
        const denominator = 1 / (va + vb + vc);
        return a.clone().addScaledVector(ab, vb * denominator).addScaledVector(ac, vc * denominator);
    };
    const rayTriangleIntersection = (origin, direction, a, b, c) => {
        const edge1 = b.clone().sub(a);
        const edge2 = c.clone().sub(a);
        const p = direction.clone().cross(edge2);
        const determinant = edge1.dot(p);
        if (Math.abs(determinant) < 1e-9) return null;
        const inverse = 1 / determinant;
        const tVector = origin.clone().sub(a);
        const u = tVector.dot(p) * inverse;
        if (u < 0 || u > 1) return null;
        const q = tVector.clone().cross(edge1);
        const v = direction.dot(q) * inverse;
        if (v < 0 || u + v > 1) return null;
        const distance = edge2.dot(q) * inverse;
        return distance >= 0 ? distance : null;
    };
    const isConstraintModelElement = node => {
        const cube = typeof Cube !== 'undefined' && node instanceof Cube;
        const mesh = typeof Mesh !== 'undefined' && node instanceof Mesh;
        return cube || mesh;
    };
    const targetModelElements = target => {
        const elements = [];
        const visited = new Set();
        const collect = node => {
            if (!node || visited.has(node)) return;
            visited.add(node);
            if (isConstraintModelElement(node)) {
                if (node.visibility !== false && node.mesh && node.mesh.visible !== false) elements.push(node);
                return;
            }
            if (Array.isArray(node.children)) node.children.forEach(collect);
        };
        collect(target);
        return elements;
    };
    const targetGeometry = target => targetModelElements(target).map(element => {
        const object = element.mesh;
        object.updateMatrixWorld(true);
        const geometry = object.geometry;
        const position = geometry && geometry.attributes && geometry.attributes.position;
        return position ? {object, geometry, position} : null;
    }).filter(Boolean);
    const targetBounds = geometryEntries => {
        const box = new THREE.Box3();
        geometryEntries.forEach(({object, position}) => {
            for (let index = 0; index < position.count; index++) {
                box.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld));
            }
        });
        const size = box.getSize(new THREE.Vector3());
        return size.x > 1e-8 && size.y > 1e-8 && size.z > 1e-8 ? box : null;
    };
    const targetTriangles = geometryEntries => {
        const triangles = [];
        geometryEntries.forEach(({object, geometry, position}) => {
            const index = geometry.index;
            const count = index ? index.count : position.count;
            for (let offset = 0; offset + 2 < count; offset += 3) {
                const ia = index ? index.getX(offset) : offset;
                const ib = index ? index.getX(offset + 1) : offset + 1;
                const ic = index ? index.getX(offset + 2) : offset + 2;
                const a = new THREE.Vector3().fromBufferAttribute(position, ia).applyMatrix4(object.matrixWorld);
                const b = new THREE.Vector3().fromBufferAttribute(position, ib).applyMatrix4(object.matrixWorld);
                const c = new THREE.Vector3().fromBufferAttribute(position, ic).applyMatrix4(object.matrixWorld);
                const normal = b.clone().sub(a).cross(c.clone().sub(a));
                if (normal.lengthSq() > 1e-12) triangles.push({a, b, c, normal: normal.normalize()});
            }
        });
        return triangles;
    };
    const boxSurfaceFrame = (point, box) => {
        if (!box || box.isEmpty()) return null;
        const closest = point.clone().clamp(box.min, box.max);
        let bestDistance = Infinity;
        let normal = new THREE.Vector3(0, 1, 0);
        const faces = [
            ['x', box.min.x, -1], ['x', box.max.x, 1],
            ['y', box.min.y, -1], ['y', box.max.y, 1],
            ['z', box.min.z, -1], ['z', box.max.z, 1]
        ];
        if (box.containsPoint(point)) {
            faces.forEach(([axis, value, sign]) => {
                const distance = Math.abs(point[axis] - value);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    closest.copy(point);
                    closest[axis] = value;
                    normal.set(0, 0, 0)[axis] = sign;
                }
            });
        } else {
            const delta = point.clone().sub(closest);
            if (delta.lengthSq() > 1e-12) normal.copy(delta).normalize();
        }
        return {point: closest, normal};
    };
    const rayAabbIntersection = (origin, direction, box) => {
        if (!box || box.isEmpty()) return null;
        const ray = new THREE.Ray(origin, direction);
        const point = ray.intersectBox(box, new THREE.Vector3());
        if (!point) return null;
        const frame = boxSurfaceFrame(point, box);
        return frame ? {point, normal: frame.normal, distance: point.distanceTo(origin)} : null;
    };
    const shrinkwrapSurfaceFrame = (bone, constraint) => {
        const target = findNode(constraint.target);
        if (!bone || !bone.mesh || !target || !target.mesh || target === bone) return null;
        normalizeShrinkwrap(constraint);
        bone.mesh.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        const origin = bone.mesh.getWorldPosition(new THREE.Vector3());
        const geometryEntries = targetGeometry(target);
        if (!geometryEntries.length) return null;
        const triangles = targetTriangles(geometryEntries);
        const box = targetBounds(geometryEntries);
        let frame = null;
        if (constraint.mode === 'project') {
            const direction = axisVector(constraint.project_axis);
            if (constraint.direction_space === 'target') direction.applyQuaternion(target.mesh.getWorldQuaternion(new THREE.Quaternion())).normalize();
            const directions = constraint.bidirectional === true ? [direction, direction.clone().negate()] : [direction];
            directions.forEach(rayDirection => {
                triangles.forEach(triangle => {
                    const distance = rayTriangleIntersection(origin, rayDirection, triangle.a, triangle.b, triangle.c);
                    if (distance !== null && (!frame || distance < frame.distance)) frame = {point: origin.clone().addScaledVector(rayDirection, distance), normal: triangle.normal.clone(), distance};
                });
            });
            if (!frame) directions.forEach(rayDirection => {
                const boxFrame = rayAabbIntersection(origin, rayDirection, box);
                if (boxFrame && (!frame || boxFrame.distance < frame.distance)) frame = boxFrame;
            });
        } else {
            triangles.forEach(triangle => {
                const point = closestPointOnTriangle(origin, triangle.a, triangle.b, triangle.c);
                const distance = point.distanceTo(origin);
                if (!frame || distance < frame.distance) frame = {point, normal: triangle.normal.clone(), distance};
            });
            if (!frame) {
                const fallback = boxSurfaceFrame(origin, box);
                if (fallback) frame = {point: fallback.point, normal: fallback.normal, distance: fallback.point.distanceTo(origin)};
            }
        }
        const maxDistance = finiteNonNegative(constraint.max_distance, 0);
        if (!frame || (maxDistance > 0 && frame.distance > maxDistance)) return null;
        if (constraint.flip_normal === true) frame.normal.negate();
        frame.point.addScaledVector(frame.normal, constraint.surface_offset);
        return frame;
    };
    const desiredShrinkwrapWorldQuaternion = (bone, constraint, frame) => {
        const upLocal = axisVector(constraint.up_axis || 'y');
        const tangentLocal = constraint.up_axis === 'x' ? axisVector('z') : axisVector('x');
        const currentWorld = bone.mesh.getWorldQuaternion(new THREE.Quaternion()).normalize();
        const tangentWorld = tangentLocal.clone().applyQuaternion(currentWorld);
        tangentWorld.addScaledVector(frame.normal, -tangentWorld.dot(frame.normal));
        return orientAxes(upLocal, tangentLocal, frame.normal, tangentWorld);
    };
    const captureShrinkwrapRotationOffset = (bone, constraint) => {
        const frame = shrinkwrapSurfaceFrame(bone, constraint);
        const desired = frame ? desiredShrinkwrapWorldQuaternion(bone, constraint, frame) : null;
        constraint.rotation_offset = desired ? desired.invert().multiply(bone.mesh.getWorldQuaternion(new THREE.Quaternion())).normalize().toArray() : [0, 0, 0, 1];
    };
    const applyShrinkwrap = (bone, constraint, influence) => {
        const frame = shrinkwrapSurfaceFrame(bone, constraint);
        if (!frame) return;
        const currentWorldPosition = bone.mesh.getWorldPosition(new THREE.Vector3());
        const positionWeight = THREE.MathUtils.clamp(Number(constraint.position_weight), 0, 1) * influence;
        const blendedWorldPosition = currentWorldPosition.lerp(frame.point, positionWeight);
        bone.mesh.position.copy(bone.mesh.parent ? bone.mesh.parent.worldToLocal(blendedWorldPosition) : blendedWorldPosition);
        if (constraint.align_rotation === true) {
            const currentWorld = bone.mesh.getWorldQuaternion(new THREE.Quaternion()).normalize();
            const desiredWorld = desiredShrinkwrapWorldQuaternion(bone, constraint, frame);
            if (constraint.maintain_rotation_offset === true) desiredWorld.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset || [0, 0, 0, 1])).normalize();
            const rotationWeight = THREE.MathUtils.clamp(Number(constraint.rotation_weight), 0, 1) * influence;
            const weightedWorld = currentWorld.slerp(desiredWorld, rotationWeight).normalize();
            const parentWorld = bone.mesh.parent ? bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
            bone.mesh.quaternion.copy(parentWorld.invert().multiply(weightedWorld).normalize());
            bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
        }
        bone.mesh.updateMatrixWorld(true);
    };
    const floorDropFrame = (bone, constraint) => {
        const target = findNode(constraint.target);
        if (!bone || !bone.mesh || !target || !target.mesh || target === bone) return null;
        normalizeFloorDrop(constraint);
        bone.mesh.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        const targetWorldQuaternion = target.mesh.getWorldQuaternion(new THREE.Quaternion()).normalize();
        const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(targetWorldQuaternion).normalize();
        const direction = axisVector(constraint.drop_axis);
        if (constraint.direction_space === 'target') direction.applyQuaternion(targetWorldQuaternion).normalize();
        const origin = bone.mesh.getWorldPosition(new THREE.Vector3());
        const planePoint = target.mesh.getWorldPosition(new THREE.Vector3());
        const signedDistance = origin.clone().sub(planePoint).dot(normal);
        const denominator = direction.dot(normal);
        if (Math.abs(denominator) < 1e-8) return null;
        if (constraint.mode === 'above_only' && (signedDistance < -1e-8 || denominator >= -1e-8)) return null;
        const t = -signedDistance / denominator;
        const maxDistance = finiteNonNegative(constraint.max_distance, 0);
        if (t < -1e-8 || (maxDistance > 0 && t - maxDistance > 1e-8)) return null;
        const hit = origin.clone().addScaledVector(direction, Math.max(0, t)).addScaledVector(normal, constraint.surface_offset);
        return {target, targetWorldQuaternion, normal, direction, origin, hit, t: Math.max(0, t)};
    };
    const desiredFloorDropWorldQuaternion = (bone, constraint, frame) => {
        const upLocal = axisVector(constraint.up_axis || 'y');
        const tangentLocal = constraint.up_axis === 'x' ? axisVector('z') : axisVector('x');
        const currentWorld = bone.mesh.getWorldQuaternion(new THREE.Quaternion()).normalize();
        const tangentWorld = tangentLocal.clone().applyQuaternion(currentWorld);
        tangentWorld.addScaledVector(frame.normal, -tangentWorld.dot(frame.normal));
        if (tangentWorld.lengthSq() < 1e-10) {
            tangentWorld.copy(new THREE.Vector3(1, 0, 0).applyQuaternion(frame.targetWorldQuaternion));
            tangentWorld.addScaledVector(frame.normal, -tangentWorld.dot(frame.normal));
        }
        return orientAxes(upLocal, tangentLocal, frame.normal, tangentWorld);
    };
    const captureFloorDropRotationOffset = (bone, constraint) => {
        const frame = floorDropFrame(bone, constraint);
        const desired = frame ? desiredFloorDropWorldQuaternion(bone, constraint, frame) : null;
        constraint.rotation_offset = desired ? desired.invert().multiply(bone.mesh.getWorldQuaternion(new THREE.Quaternion())).normalize().toArray() : [0, 0, 0, 1];
    };
    const applyFloorDrop = (bone, constraint, influence) => {
        const frame = floorDropFrame(bone, constraint);
        if (!frame) return;
        const positionWeight = THREE.MathUtils.clamp(Number(constraint.position_weight), 0, 1) * influence;
        const blendedWorldPosition = frame.origin.clone().lerp(frame.hit, positionWeight);
        bone.mesh.position.copy(bone.mesh.parent ? bone.mesh.parent.worldToLocal(blendedWorldPosition) : blendedWorldPosition);
        if (constraint.align_rotation === true) {
            let desiredWorld = desiredFloorDropWorldQuaternion(bone, constraint, frame);
            if (constraint.maintain_rotation_offset === true) desiredWorld.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset)).normalize();
            const currentWorld = bone.mesh.getWorldQuaternion(new THREE.Quaternion()).normalize();
            const rotationWeight = THREE.MathUtils.clamp(Number(constraint.rotation_weight), 0, 1) * influence;
            const weightedWorld = currentWorld.slerp(desiredWorld, rotationWeight).normalize();
            const parentWorld = bone.mesh.parent ? bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
            bone.mesh.quaternion.copy(parentWorld.invert().multiply(weightedWorld).normalize());
            bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
        }
        bone.mesh.updateMatrixWorld(true);
    };
    const desiredTrackingWorldQuaternion = (bone, target, constraint) => {
        const direction = trackingDirection(bone, target);
        if (direction.lengthSq() < 1e-10) return null;
        const trackAxis = axisVector(constraint.track_axis || 'z');
        if (constraint.type === 'damped_track') {
            const currentWorld = bone.mesh.getWorldQuaternion(new THREE.Quaternion());
            const currentTrack = trackAxis.clone().applyQuaternion(currentWorld).normalize();
            const targetDirection = direction.normalize();
            const fullAngle = currentTrack.angleTo(targetDirection);
            if (fullAngle < 1e-8) return currentWorld;
            const limit = THREE.MathUtils.clamp(Math.degToRad(Number(constraint.damping_angle) || 0), 0, Math.PI);
            const factor = limit > 0 ? Math.min(1, limit / fullAngle) : 1;
            return new THREE.Quaternion().setFromUnitVectors(currentTrack, targetDirection).slerp(new THREE.Quaternion(), 1 - factor).multiply(currentWorld).normalize();
        }
        if (constraint.type === 'locked_track') {
            const lockAxis = axisVector(constraint.lock_axis || 'y');
            if (Math.abs(trackAxis.dot(lockAxis)) > 0.999) return null;
            const currentWorld = bone.mesh.getWorldQuaternion(new THREE.Quaternion());
            const lockedWorld = lockAxis.clone().applyQuaternion(currentWorld).normalize();
            const projected = direction.sub(lockedWorld.clone().multiplyScalar(direction.dot(lockedWorld)));
            if (projected.lengthSq() < 1e-10) return currentWorld;
            return orientAxes(trackAxis, lockAxis, projected, lockedWorld);
        }
        const upAxis = axisVector(constraint.up_axis || 'y');
        if (Math.abs(trackAxis.dot(upAxis)) > 0.999) return null;
        return orientAxes(trackAxis, upAxis, direction, trackingUp(target, constraint));
    };
    const captureTrackOffset = (bone, constraint) => {
        const target = findNode(constraint.target);
        if (!bone || !bone.mesh || !target || !target.mesh || target === bone) {
            constraint.rotation_offset = [0, 0, 0, 1];
            return;
        }
        bone.mesh.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        const desired = desiredTrackingWorldQuaternion(bone, target, constraint);
        constraint.rotation_offset = desired ? desired.clone().invert().multiply(bone.mesh.getWorldQuaternion(new THREE.Quaternion())).normalize().toArray() : [0, 0, 0, 1];
    };
    const applyTracking = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        bone.mesh.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        const desiredWorld = desiredTrackingWorldQuaternion(bone, target, constraint);
        if (!desiredWorld) return;
        if (constraint.maintain_offset === true) desiredWorld.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset || [0, 0, 0, 1])).normalize();
        const parentWorld = bone.mesh.parent ? bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
        const desiredLocal = parentWorld.invert().multiply(desiredWorld).normalize();
        bone.mesh.quaternion.slerp(desiredLocal, influence).normalize();
        bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
        bone.mesh.updateMatrixWorld(true);
    };
    const captureStretchTo = (bone, constraint) => {
        const target = findNode(constraint.target);
        if (!bone || !bone.mesh || !target || !target.mesh || target === bone) {
            constraint.original_length = 0;
            constraint.rotation_offset = [0, 0, 0, 1];
            return;
        }
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        bone.mesh.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        const ownerPosition = bone.mesh.getWorldPosition(new THREE.Vector3());
        const targetPosition = target.mesh.getWorldPosition(new THREE.Vector3());
        constraint.original_length = ownerPosition.distanceTo(targetPosition);
        const direction = targetPosition.sub(ownerPosition);
        const mainAxis = axisVector(constraint.main_axis || 'y');
        const upAxis = axisVector(constraint.up_axis || 'z');
        const currentWorld = bone.mesh.getWorldQuaternion(new THREE.Quaternion()).normalize();
        const stableUp = upAxis.clone().applyQuaternion(currentWorld).normalize();
        const desired = direction.lengthSq() >= 1e-10 && Math.abs(mainAxis.dot(upAxis)) < 0.999
            ? orientAxes(mainAxis, upAxis, direction, stableUp)
            : currentWorld;
        constraint.rotation_offset = constraint.maintain_offset === true
            ? desired.clone().invert().multiply(currentWorld).normalize().toArray()
            : [0, 0, 0, 1];
    };
    const captureMaintainVolumeReference = (bone, constraint) => {
        const axis = ['x', 'y', 'z'].includes(constraint.main_axis) ? constraint.main_axis : 'x';
        const scale = bone && bone.mesh ? Math.abs(Number(bone.mesh.scale[axis])) : 1;
        constraint.reference_scale = Math.max(1e-8, Number.isFinite(scale) ? scale : 1);
    };
    const applyMaintainVolume = (bone, constraint, influence) => {
        const axes = ['x', 'y', 'z'];
        const mainAxis = axes.includes(constraint.main_axis) ? constraint.main_axis : 'x';
        const currentScale = bone.mesh.scale.clone();
        const referenceScale = Math.max(1e-8, Math.abs(Number(constraint.reference_scale)) || 1);
        const currentMainScale = Math.max(1e-8, Math.abs(Number(currentScale[mainAxis])) || 0);
        const ratio = Math.max(1e-8, currentMainScale / referenceScale);
        const exponentValue = Number(constraint.exponent);
        const compensationWeightValue = Number(constraint.compensation_weight);
        const exponent = THREE.MathUtils.clamp(Number.isFinite(exponentValue) ? exponentValue : 1, 0, 2);
        const compensationWeight = THREE.MathUtils.clamp(Number.isFinite(compensationWeightValue) ? compensationWeightValue : 1, 0, 1);
        let minimum = finiteNonNegative(constraint.min_factor, 0);
        let maximum = finiteNonNegative(constraint.max_factor, 100);
        if (minimum > maximum) [minimum, maximum] = [maximum, minimum];
        const mode = ['volume', 'area', 'uniform', 'custom'].includes(constraint.mode) ? constraint.mode : 'volume';
        const desiredScale = currentScale.clone();
        axes.forEach(axis => {
            if (axis === mainAxis && mode !== 'uniform') return;
            const customWeightValue = Number(constraint['custom_' + axis]);
            const customWeight = THREE.MathUtils.clamp(Number.isFinite(customWeightValue) ? customWeightValue : 1, 0, 1);
            const axisExponent = mode === 'volume' ? exponent / 2 : mode === 'uniform' ? exponent / 3 : mode === 'custom' ? exponent * customWeight : exponent;
            const rawFactor = Math.pow(ratio, -axisExponent);
            const factor = THREE.MathUtils.clamp(Number.isFinite(rawFactor) ? rawFactor : 1, minimum, maximum);
            const weightedFactor = THREE.MathUtils.lerp(1, factor, compensationWeight);
            desiredScale[axis] = currentScale[axis] * weightedFactor;
        });
        bone.mesh.scale.lerp(desiredScale, influence);
        bone.mesh.updateMatrixWorld(true);
    };
    const applyStretchTo = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        bone.mesh.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        const ownerPosition = bone.mesh.getWorldPosition(new THREE.Vector3());
        const direction = target.mesh.getWorldPosition(new THREE.Vector3()).sub(ownerPosition);
        const distance = direction.length();
        if (distance < 1e-8) return;
        const mainAxis = axisVector(constraint.main_axis || 'y');
        const upAxis = axisVector(constraint.up_axis || 'z');
        if (Math.abs(mainAxis.dot(upAxis)) > 0.999) return;
        const currentLocal = bone.mesh.quaternion.clone().normalize();
        const currentWorld = bone.mesh.getWorldQuaternion(new THREE.Quaternion()).normalize();
        const stableUp = upAxis.clone().applyQuaternion(currentWorld).normalize();
        const desiredWorld = orientAxes(mainAxis, upAxis, direction, stableUp);
        if (constraint.maintain_offset === true) desiredWorld.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset || [0, 0, 0, 1])).normalize();
        const rotationWeight = THREE.MathUtils.clamp(Number(constraint.rotation_weight), 0, 1);
        const weightedWorld = currentWorld.clone().slerp(desiredWorld, rotationWeight).normalize();
        const parentWorld = bone.mesh.parent ? bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
        const weightedLocal = parentWorld.invert().multiply(weightedWorld).normalize();
        bone.mesh.quaternion.copy(currentLocal.slerp(weightedLocal, influence).normalize());
        bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
        const originalLength = Math.max(1e-8, Number(constraint.original_length) || distance);
        let minimum = finiteNonNegative(constraint.min_stretch_ratio, 0);
        let maximum = finiteNonNegative(constraint.max_stretch_ratio, 100);
        if (minimum > maximum) [minimum, maximum] = [maximum, minimum];
        const clampedRatio = THREE.MathUtils.clamp(distance / originalLength, minimum, maximum);
        const stretchWeight = THREE.MathUtils.clamp(Number(constraint.stretch_weight), 0, 1);
        const longitudinal = THREE.MathUtils.lerp(1, clampedRatio, stretchWeight);
        const exponent = THREE.MathUtils.clamp(Number(constraint.volume_exponent) || 0, 0, 1);
        const volumeFactor = Math.pow(clampedRatio, -exponent / 2);
        const transverse = constraint.volume_mode === 'preserve' ? THREE.MathUtils.lerp(1, volumeFactor, stretchWeight) : 1;
        const mainIndex = Math.abs(mainAxis.x) > 0.5 ? 0 : Math.abs(mainAxis.y) > 0.5 ? 1 : 2;
        const desiredScale = bone.mesh.scale.clone();
        ['x', 'y', 'z'].forEach((axis, index) => desiredScale[axis] *= index === mainIndex ? longitudinal : transverse);
        bone.mesh.scale.lerp(desiredScale, influence);
        bone.mesh.updateMatrixWorld(true);
    };
    const pathTargets = (bone, constraint) => {
        const seen = new Set();
        return (Array.isArray(constraint.path_points) ? constraint.path_points : []).map(point => findNode(point && point.target)).filter(target => {
            if (!target || !target.mesh || target === bone || seen.has(target.uuid)) return false;
            seen.add(target.uuid);
            target.mesh.updateMatrixWorld(true);
            return true;
        });
    };
    const pathPositions = (bone, constraint) => pathTargets(bone, constraint).map(target => target.mesh.getWorldPosition(new THREE.Vector3()));
    const collectSplineChain = (tail, chainLength) => {
        const chain = [];
        let current = tail;
        const limit = Math.max(0, Math.floor(Number(chainLength) || 0));
        while (current instanceof ArmatureBone && (!limit || chain.length < limit)) {
            chain.push(current);
            current = current.parent instanceof ArmatureBone ? current.parent : null;
        }
        return chain.reverse();
    };
    const catmullRomVector = (p0, p1, p2, p3, t) => {
        const t2 = t * t;
        const t3 = t2 * t;
        return new THREE.Vector3().copy(p1).multiplyScalar(2).add(p2.clone().sub(p0).multiplyScalar(t)).add(p0.clone().multiplyScalar(2).sub(p1.clone().multiplyScalar(5)).add(p2.clone().multiplyScalar(4)).sub(p3).multiplyScalar(t2)).add(p0.clone().negate().add(p1.clone().multiplyScalar(3)).sub(p2.clone().multiplyScalar(3)).add(p3).multiplyScalar(t3)).multiplyScalar(0.5);
    };
    const catmullRomTangent = (p0, p1, p2, p3, t) => {
        const t2 = t * t;
        return p2.clone().sub(p0).add(p0.clone().multiplyScalar(2).sub(p1.clone().multiplyScalar(5)).add(p2.clone().multiplyScalar(4)).sub(p3).multiplyScalar(2 * t)).add(p0.clone().negate().add(p1.clone().multiplyScalar(3)).sub(p2.clone().multiplyScalar(3)).add(p3).multiplyScalar(3 * t2)).multiplyScalar(0.5);
    };
    const evaluatePath = (points, progress, interpolation, closed) => {
        const count = points.length;
        if (count < 2) return null;
        const segmentCount = closed ? count : count - 1;
        const scaled = THREE.MathUtils.clamp(progress, 0, 1) * segmentCount;
        const segment = Math.min(Math.floor(scaled), segmentCount - 1);
        const t = scaled - segment;
        const at = index => closed ? points[(index % count + count) % count] : points[THREE.MathUtils.clamp(index, 0, count - 1)];
        const p1 = at(segment);
        const p2 = at(segment + 1);
        if (interpolation !== 'catmull_rom') return {position: p1.clone().lerp(p2, t), tangent: p2.clone().sub(p1)};
        return {position: catmullRomVector(at(segment - 1), p1, p2, at(segment + 2), t), tangent: catmullRomTangent(at(segment - 1), p1, p2, at(segment + 2), t)};
    };
    const stablePathTangent = (points, progress, interpolation, closed, tangent) => {
        if (tangent && tangent.lengthSq() >= 1e-10) return tangent.normalize();
        const steps = Math.max(8, points.length * 4);
        for (let step = 1; step <= steps; step++) {
            const delta = step / (steps * Math.max(1, closed ? points.length : points.length - 1));
            const beforeProgress = closed ? (progress - delta + 1) % 1 : Math.max(0, progress - delta);
            const afterProgress = closed ? (progress + delta) % 1 : Math.min(1, progress + delta);
            const before = evaluatePath(points, beforeProgress, interpolation, closed);
            const after = evaluatePath(points, afterProgress, interpolation, closed);
            const candidate = after && before ? after.position.clone().sub(before.position) : new THREE.Vector3();
            if (candidate.lengthSq() >= 1e-10) return candidate.normalize();
        }
        return null;
    };
    const buildPathArcLut = (points, interpolation, closed) => {
        const divisions = Math.max(32, points.length * (interpolation === 'catmull_rom' ? 32 : 8));
        const entries = [];
        let total = 0;
        let previous = evaluatePath(points, 0, interpolation, closed);
        if (!previous) return {entries, total};
        entries.push({progress: 0, length: 0, position: previous.position.clone(), tangent: previous.tangent.clone()});
        for (let index = 1; index <= divisions; index++) {
            const progress = index / divisions;
            const evaluated = evaluatePath(points, progress, interpolation, closed);
            total += evaluated.position.distanceTo(previous.position);
            entries.push({progress, length: total, position: evaluated.position.clone(), tangent: evaluated.tangent.clone()});
            previous = evaluated;
        }
        return {entries, total};
    };
    const evaluatePathAtLength = (points, interpolation, closed, lut, length) => {
        if (!lut.entries.length) return null;
        const target = THREE.MathUtils.clamp(length, 0, lut.total);
        let low = 0;
        let high = lut.entries.length - 1;
        while (low + 1 < high) {
            const middle = (low + high) >> 1;
            if (lut.entries[middle].length < target) low = middle;
            else high = middle;
        }
        const start = lut.entries[low];
        const end = lut.entries[high];
        const span = end.length - start.length;
        const alpha = span > 1e-8 ? (target - start.length) / span : 0;
        return evaluatePath(points, THREE.MathUtils.lerp(start.progress, end.progress, alpha), interpolation, closed);
    };
    const transportSplineFrames = samples => {
        if (!samples.length) return samples;
        let tangent = samples[0].tangent.clone().normalize();
        let normal = Math.abs(tangent.y) < 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
        samples[0].normal = normal.clone();
        samples[0].binormal = tangent.clone().cross(normal).normalize();
        for (let index = 1; index < samples.length; index++) {
            const nextTangent = samples[index].tangent.clone().normalize();
            const dot = THREE.MathUtils.clamp(tangent.dot(nextTangent), -1, 1);
            if (dot < 0.999999) {
                let axis = tangent.clone().cross(nextTangent);
                if (axis.lengthSq() < 1e-10) axis = normal.clone();
                else axis.normalize();
                normal.applyAxisAngle(axis, Math.acos(dot));
            }
            normal.addScaledVector(nextTangent, -normal.dot(nextTangent));
            if (normal.lengthSq() < 1e-10) normal.copy(Math.abs(nextTangent.y) < 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).addScaledVector(nextTangent, -normal.dot(nextTangent));
            normal.normalize();
            samples[index].normal = normal.clone();
            samples[index].binormal = nextTangent.clone().cross(normal).normalize();
            tangent = nextTangent;
        }
        return samples;
    };
    const desiredPathWorldQuaternion = (bone, constraint, evaluated, points, progress) => {
        const forward = axisVector(constraint.forward_axis || 'z');
        const up = axisVector(constraint.up_axis || 'y');
        if (Math.abs(forward.dot(up)) > 0.999) return null;
        const tangent = stablePathTangent(points, progress, constraint.interpolation, constraint.closed === true, evaluated.tangent);
        if (!tangent) return null;
        const worldUp = Math.abs(tangent.y) < 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const desired = orientAxes(forward, up, tangent, worldUp);
        const bank = Number(constraint.bank);
        if (Number.isFinite(bank) && Math.abs(bank) > 1e-8) desired.premultiply(new THREE.Quaternion().setFromAxisAngle(tangent, Math.degToRad(bank))).normalize();
        return desired;
    };
    const applyClampTo = (bone, constraint, influence) => {
        const points = pathPositions(bone, constraint);
        if (points.length < 2) return;
        bone.mesh.updateMatrixWorld(true);
        const ownerPosition = constraint.owner_space === 'world' ? bone.mesh.getWorldPosition(new THREE.Vector3()) : bone.mesh.position;
        const axis = constraint.driver_axis.replace('-', '');
        const sign = constraint.driver_axis.startsWith('-') ? -1 : 1;
        const value = ownerPosition[axis] * sign;
        const inputMin = Number(constraint.input_min);
        const inputMax = Number(constraint.input_max);
        let progress = 0;
        if (inputMin !== inputMax) {
            progress = THREE.MathUtils.clamp((value - inputMin) / (inputMax - inputMin), 0, 1);
            if (constraint.reverse === true) progress = 1 - progress;
        }
        const evaluated = evaluatePath(points, progress, constraint.interpolation, constraint.closed === true);
        if (!evaluated) return;
        const offset = Array.isArray(constraint.offset) && constraint.offset.length === 3 ? new THREE.Vector3().fromArray(constraint.offset) : new THREE.Vector3();
        const currentWorldPosition = bone.mesh.getWorldPosition(new THREE.Vector3());
        const blendedWorldPosition = currentWorldPosition.lerp(evaluated.position.add(offset), influence);
        bone.mesh.position.copy(bone.mesh.parent ? bone.mesh.parent.worldToLocal(blendedWorldPosition) : blendedWorldPosition);
        bone.mesh.updateMatrixWorld(true);
    };
    const capturePathRotationOffset = (bone, constraint) => {
        const points = pathPositions(bone, constraint);
        const progress = pathProgressAt(bone, constraint);
        const evaluated = evaluatePath(points, progress, constraint.interpolation, constraint.closed === true);
        const desired = evaluated && bone && bone.mesh ? desiredPathWorldQuaternion(bone, constraint, evaluated, points, progress) : null;
        constraint.rotation_offset = desired ? desired.invert().multiply(bone.mesh.getWorldQuaternion(new THREE.Quaternion())).normalize().toArray() : [0, 0, 0, 1];
    };
    const applySplineIK = (tail, constraint, influence, writtenBones) => {
        normalizeFollowPath(constraint);
        const chain = collectSplineChain(tail, constraint.chain_length);
        const points = pathPositions(tail, constraint);
        if (chain.length < 2 || points.length < 2 || writtenBones && chain.some(bone => writtenBones.has(bone.uuid))) return;
        if (writtenBones) chain.forEach(bone => writtenBones.add(bone.uuid));
        const interpolation = constraint.interpolation;
        const closed = constraint.closed === true;
        const lut = buildPathArcLut(points, interpolation, closed);
        if (lut.total < 1e-8) return;
        chain.forEach(bone => bone.mesh.updateMatrixWorld(true));
        const originalWorld = chain.map(bone => decompose(bone.mesh.matrixWorld));
        const segmentLengths = chain.slice(1).map((bone, index) => originalWorld[index].position.distanceTo(originalWorld[index + 1].position));
        const chainLength = segmentLengths.reduce((sum, length) => sum + length, 0);
        if (chainLength < 1e-8) return;
        const fittedLength = constraint.stretch === true ? lut.total : Math.min(chainLength, lut.total);
        const stretchRatio = fittedLength / chainLength;
        const samples = [];
        let distance = 0;
        chain.forEach((bone, index) => {
            if (index > 0) distance += segmentLengths[index - 1] * stretchRatio;
            const evaluated = evaluatePathAtLength(points, interpolation, closed, lut, distance);
            if (evaluated) samples.push({position: evaluated.position, tangent: stablePathTangent(points, distance / lut.total, interpolation, closed, evaluated.tangent)});
        });
        if (samples.length !== chain.length || samples.some(sample => !sample.tangent)) return;
        transportSplineFrames(samples);
        const offset = Array.isArray(constraint.offset) && constraint.offset.length === 3 ? new THREE.Vector3().fromArray(constraint.offset) : new THREE.Vector3();
        const rootShift = constraint.root_follow === false ? originalWorld[0].position.clone().sub(samples[0].position).sub(offset) : new THREE.Vector3();
        const forward = axisVector(constraint.forward_axis);
        const up = axisVector(constraint.up_axis);
        const roll = Math.degToRad(Number(constraint.roll) || 0);
        const desiredWorld = samples.map((sample, index) => {
            const tangent = sample.tangent.clone().normalize();
            const normal = sample.normal.clone();
            if (Math.abs(roll) > 1e-8) normal.applyAxisAngle(tangent, roll).normalize();
            const quaternion = orientAxes(forward, up, tangent, normal);
            const scale = originalWorld[index].scale.clone();
            const mainAxis = constraint.forward_axis.replace('-', '');
            if (constraint.stretch === true) scale[mainAxis] *= stretchRatio;
            if (constraint.volume === true && constraint.stretch === true) {
                const transverse = 1 / Math.sqrt(Math.max(1e-8, stretchRatio));
                ['x', 'y', 'z'].forEach(axis => { if (axis !== mainAxis) scale[axis] *= transverse; });
            }
            return {position: sample.position.clone().add(offset).add(rootShift), quaternion, scale};
        });
        chain.forEach((bone, index) => {
            const desiredMatrix = compose(desiredWorld[index]);
            const desiredLocal = bone.mesh.parent ? bone.mesh.parent.matrixWorld.clone().invert().multiply(desiredMatrix) : desiredMatrix;
            const current = decompose(bone.mesh.matrix);
            const target = decompose(desiredLocal);
            current.position.lerp(target.position, influence);
            current.quaternion.slerp(target.quaternion, influence).normalize();
            current.scale.lerp(target.scale, influence);
            bone.mesh.matrix.copy(compose(current));
            bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
            bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
            bone.mesh.updateMatrixWorld(true);
        });
    };
    const applyFollowPath = (bone, constraint, influence) => {
        const points = pathPositions(bone, constraint);
        if (points.length < 2) return;
        const progress = pathProgressAt(bone, constraint);
        const evaluated = evaluatePath(points, progress, constraint.interpolation, constraint.closed === true);
        if (!evaluated) return;
        const offset = Array.isArray(constraint.offset) && constraint.offset.length === 3 ? new THREE.Vector3().fromArray(constraint.offset) : new THREE.Vector3();
        const currentWorldPosition = bone.mesh.getWorldPosition(new THREE.Vector3());
        const positionWeight = THREE.MathUtils.clamp(Number(constraint.position_weight), 0, 1) * influence;
        const desiredWorldPosition = evaluated.position.add(offset);
        const blendedWorldPosition = currentWorldPosition.lerp(desiredWorldPosition, positionWeight);
        bone.mesh.position.copy(bone.mesh.parent ? bone.mesh.parent.worldToLocal(blendedWorldPosition.clone()) : blendedWorldPosition);
        if (constraint.follow_rotation === true) {
            let desiredWorld = desiredPathWorldQuaternion(bone, constraint, evaluated, points, progress);
            if (desiredWorld) {
                if (constraint.maintain_rotation_offset === true) desiredWorld.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset || [0, 0, 0, 1])).normalize();
                const currentWorld = bone.mesh.getWorldQuaternion(new THREE.Quaternion()).normalize();
                const rotationWeight = THREE.MathUtils.clamp(Number(constraint.rotation_weight), 0, 1) * influence;
                const weightedWorld = currentWorld.slerp(desiredWorld, rotationWeight).normalize();
                const parentWorld = bone.mesh.parent ? bone.mesh.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
                bone.mesh.quaternion.copy(parentWorld.invert().multiply(weightedWorld).normalize());
                bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
            }
        }
        bone.mesh.updateMatrixWorld(true);
    };
    const armatureSourceMatrix = entry => {
        const target = findNode(entry && entry.target);
        if (!target || !target.mesh) return null;
        target.mesh.updateMatrixWorld(true);
        return (entry.source_space === 'local' ? target.mesh.matrix : target.mesh.matrixWorld).clone();
    };
    const armatureOwnerMatrix = (bone, constraint) => {
        bone.mesh.updateMatrixWorld(true);
        return (constraint.target_space === 'local' ? bone.mesh.matrix : bone.mesh.matrixWorld).clone();
    };
    const captureArmatureOffset = (bone, constraint, entry) => {
        const source = armatureSourceMatrix(entry);
        if (!bone || !bone.mesh || !source || findNode(entry.target) === bone) {
            if (entry) entry.offset_matrix = new THREE.Matrix4().toArray();
            return false;
        }
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        entry.offset_matrix = source.invert().multiply(armatureOwnerMatrix(bone, constraint)).toArray();
        return true;
    };
    const applyArmatureBlend = (bone, constraint, influence) => {
        const currentMatrix = armatureOwnerMatrix(bone, constraint);
        const current = decompose(currentMatrix);
        const valid = (Array.isArray(constraint.entries) ? constraint.entries : []).map(entry => {
            const target = findNode(entry.target);
            const source = armatureSourceMatrix(entry);
            const weight = armatureWeightAt(bone, constraint, entry);
            if (!target || target === bone || !source || weight <= 0) return null;
            if (constraint.maintain_offset === true) source.multiply(new THREE.Matrix4().fromArray(entry.offset_matrix));
            return {transform: decompose(source), weight};
        }).filter(Boolean);
        const totalWeight = valid.reduce((sum, item) => sum + item.weight, 0);
        if (totalWeight <= 1e-8) return;
        const normalize = constraint.normalize_weights !== false;
        const targetTotal = normalize ? 1 : Math.min(1, totalWeight);
        const desired = {
            position: current.position.clone().multiplyScalar(1 - targetTotal),
            quaternion: normalize ? null : current.quaternion.clone(),
            scale: current.scale.clone().multiplyScalar(1 - targetTotal)
        };
        let accumulatedRotationWeight = normalize ? 0 : 1 - targetTotal;
        valid.forEach(item => {
            const weight = normalize ? item.weight / totalWeight : item.weight * targetTotal / totalWeight;
            desired.position.addScaledVector(item.transform.position, weight);
            desired.scale.addScaledVector(item.transform.scale, weight);
            if (!desired.quaternion) desired.quaternion = item.transform.quaternion.clone().normalize();
            else {
                const step = weight / (accumulatedRotationWeight + weight);
                desired.quaternion.slerp(item.transform.quaternion, step).normalize();
            }
            accumulatedRotationWeight += weight;
        });
        if (!desired.quaternion) return;
        const channels = constraint.channels || {};
        ['position', 'scale'].forEach(channel => {
            if (channels[channel] === false) desired[channel].copy(current[channel]);
            else ['x', 'y', 'z'].forEach(axis => { if (constraint[channel + '_axes'] && constraint[channel + '_axes'][axis] === false) desired[channel][axis] = current[channel][axis]; });
        });
        if (channels.rotation === false) desired.quaternion.copy(current.quaternion);
        else {
            const order = Format.euler_order || 'ZYX';
            const currentEuler = new THREE.Euler().setFromQuaternion(current.quaternion, order);
            const desiredEuler = new THREE.Euler().setFromQuaternion(desired.quaternion, order);
            ['x', 'y', 'z'].forEach(axis => { if (constraint.rotation_axes && constraint.rotation_axes[axis] === false) desiredEuler[axis] = currentEuler[axis]; });
            desired.quaternion.setFromEuler(desiredEuler).normalize();
        }
        current.position.lerp(desired.position, influence);
        current.quaternion.slerp(desired.quaternion, influence).normalize();
        current.scale.lerp(desired.scale, influence);
        const result = compose(current);
        const local = constraint.target_space === 'world' ? localFromWorld(bone, result) : result;
        bone.mesh.matrix.copy(local);
        bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
        bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
        bone.mesh.updateMatrixWorld(true);
    };
    const captureSpaceOffset = (bone, entry) => {
        const target = findNode(entry && entry.target);
        if (!bone || !bone.mesh || !target || !target.mesh || target === bone) {
            if (entry) entry.offset_matrix = new THREE.Matrix4().toArray();
            return false;
        }
        if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        bone.mesh.updateMatrixWorld(true);
        entry.offset_matrix = target.mesh.matrixWorld.clone().invert().multiply(bone.mesh.matrixWorld).toArray();
        return true;
    };
    const applySpaceSwitch = (bone, constraint, influence) => {
        const entries = Array.isArray(constraint.entries) ? constraint.entries : [];
        const weighted = entries.map(entry => ({entry, target: findNode(entry.target), weight: spaceWeightAt(bone, constraint, entry)})).filter(item => item.target && item.target.mesh && item.target !== bone && item.weight > 0);
        const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
        if (totalWeight <= 1e-8) return;
        let blendedPosition = new THREE.Vector3();
        let blendedScale = new THREE.Vector3();
        let blendedQuaternion = null;
        let accumulatedWeight = 0;
        weighted.forEach(item => {
            item.target.mesh.updateMatrixWorld(true);
            const offset = Array.isArray(item.entry.offset_matrix) && item.entry.offset_matrix.length === 16 ? new THREE.Matrix4().fromArray(item.entry.offset_matrix) : new THREE.Matrix4();
            const transform = decompose(item.target.mesh.matrixWorld.clone().multiply(offset));
            const normalizedWeight = item.weight / totalWeight;
            blendedPosition.addScaledVector(transform.position, normalizedWeight);
            blendedScale.addScaledVector(transform.scale, normalizedWeight);
            if (!blendedQuaternion) blendedQuaternion = transform.quaternion.clone().normalize();
            else {
                const step = normalizedWeight / (accumulatedWeight + normalizedWeight);
                blendedQuaternion.slerp(transform.quaternion, step).normalize();
            }
            accumulatedWeight += normalizedWeight;
        });
        if (!blendedQuaternion) return;
        const current = decompose(bone.mesh.matrix);
        const desired = decompose(localFromWorld(bone, new THREE.Matrix4().compose(blendedPosition, blendedQuaternion, blendedScale)));
        current.position.lerp(desired.position, influence);
        current.quaternion.slerp(desired.quaternion, influence).normalize();
        current.scale.lerp(desired.scale, influence);
        bone.mesh.matrix.copy(compose(current));
        bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
        bone.mesh.updateMatrixWorld(true);
    };
    const findAnimation = uuid => (typeof Animation !== 'undefined' && Array.isArray(Animation.all) ? Animation.all : []).find(animation => animation.uuid === uuid);
    const actionConstraintOwnerUuid = constraint => constraint.action_owner_uuid || (Animation.selected && Animation.selected.uuid) || '';
    const actionDependencies = actionUuid => {
        const dependencies = new Set();
        ArmatureBone.all.forEach(owner => getStack(owner).forEach(constraint => {
            if (constraint && constraint.type === 'action_constraint' && constraint.enabled !== false && actionConstraintOwnerUuid(constraint) === actionUuid && constraint.action_uuid) dependencies.add(constraint.action_uuid);
        }));
        return dependencies;
    };
    const actionCreatesRecursion = (ownerUuid, sourceUuid) => {
        if (!ownerUuid || !sourceUuid || ownerUuid === sourceUuid) return true;
        const visited = new Set();
        const pending = [sourceUuid];
        while (pending.length) {
            const uuid = pending.pop();
            if (uuid === ownerUuid) return true;
            if (visited.has(uuid)) continue;
            visited.add(uuid);
            actionDependencies(uuid).forEach(dependency => pending.push(dependency));
        }
        return false;
    };
    const availableActions = constraint => {
        const ownerUuid = actionConstraintOwnerUuid(constraint || {});
        return (typeof Animation !== 'undefined' && Array.isArray(Animation.all) ? Animation.all : []).filter(animation => !actionCreatesRecursion(ownerUuid, animation.uuid));
    };
    const getActionAnimator = (action, bone) => {
        if (!action || !bone || !action.animators) return null;
        const direct = action.animators[bone.uuid];
        return direct && direct instanceof BoneAnimator ? direct : null;
    };
    const sampleActionChannel = (action, animator, bone, channel, time, fallback) => {
        if (!animator || !Array.isArray(animator[channel]) || !animator[channel].length) return fallback.slice();
        const previousTimelineTime = Timeline.time;
        const previousLoop = action.loop;
        const previousGroup = animator.group;
        const previousElement = animator.element;
        try {
            Timeline.time = time;
            action.loop = 'once';
            animator.group = bone;
            animator.element = bone;
            Animator.resetLastValues();
            const value = animator.interpolate(channel, false);
            return Array.isArray(value) ? value.map((entry, index) => Number.isFinite(Number(entry)) ? Number(entry) : fallback[index]) : fallback.slice();
        } finally {
            Timeline.time = previousTimelineTime;
            action.loop = previousLoop;
            animator.group = previousGroup;
            animator.element = previousElement;
        }
    };
    const sampleActionTransform = (action, bone, time) => {
        const animator = getActionAnimator(action, bone);
        if (!animator) return null;
        const restPosition = bone.mesh.fix_position ? bone.mesh.fix_position.clone() : new THREE.Vector3().fromArray(bone.origin || [0, 0, 0]);
        const restRotation = bone.mesh.fix_rotation ? bone.mesh.fix_rotation.clone() : new THREE.Euler(0, 0, 0, Format.euler_order || 'ZYX');
        const positionOffset = sampleActionChannel(action, animator, bone, 'position', time, [0, 0, 0]);
        const rotationOffset = sampleActionChannel(action, animator, bone, 'rotation', time, [0, 0, 0]);
        const scale = sampleActionChannel(action, animator, bone, 'scale', time, [1, 1, 1]);
        const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            restRotation.x + Math.degToRad(rotationOffset[0]),
            restRotation.y + Math.degToRad(rotationOffset[1]),
            restRotation.z + Math.degToRad(rotationOffset[2]),
            restRotation.order || Format.euler_order || 'ZYX'
        ));
        return {
            position: restPosition.add(new THREE.Vector3().fromArray(positionOffset)),
            quaternion,
            scale: new THREE.Vector3().fromArray(scale)
        };
    };
    const actionDriverValue = (bone, constraint) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh) return null;
        target.mesh.updateMatrixWorld(true);
        const transform = constraint.source_space === 'world' ? decompose(target.mesh.matrixWorld) : decompose(target.mesh.matrix);
        const values = constraint.driver_channel === 'rotation'
            ? new THREE.Euler().setFromQuaternion(transform.quaternion, Format.euler_order || 'ZYX')
            : transform[constraint.driver_channel];
        const axis = constraint.driver_axis.replace('-', '');
        let value = Number(values[axis]) || 0;
        if (constraint.driver_channel === 'rotation') value = Math.radToDeg(value);
        return constraint.driver_axis.startsWith('-') ? -value : value;
    };
    const mapActionTime = (constraint, driver) => {
        if (!Number.isFinite(driver)) return Number(constraint.action_start) || 0;
        const minimum = Number(constraint.input_min);
        const maximum = Number(constraint.input_max);
        let factor = Math.abs(maximum - minimum) < 1e-8 ? 0 : (driver - minimum) / (maximum - minimum);
        if (constraint.mapping === 'loop') factor = ((factor % 1) + 1) % 1;
        else if (constraint.mapping === 'pingpong') {
            factor = ((factor % 2) + 2) % 2;
            if (factor > 1) factor = 2 - factor;
        } else factor = THREE.MathUtils.clamp(factor, 0, 1);
        if (constraint.reverse === true) factor = 1 - factor;
        return THREE.MathUtils.lerp(Number(constraint.action_start) || 0, Number(constraint.action_end) || 0, factor);
    };
    const safeScaleRatio = (owner, sampled) => Math.abs(sampled) > 1e-8 ? owner / sampled : 1;
    const captureActionOffset = (bone, constraint) => {
        normalizeActionConstraint(constraint);
        const action = findAnimation(constraint.action_uuid);
        const driver = actionDriverValue(bone, constraint);
        const sampled = action && driver !== null && sampleActionTransform(action, bone, mapActionTime(constraint, driver));
        if (!sampled) {
            constraint.position_offset = [0, 0, 0];
            constraint.rotation_offset = [0, 0, 0, 1];
            constraint.scale_offset = [1, 1, 1];
            return false;
        }
        const current = decompose(bone.mesh.matrix);
        constraint.position_offset = current.position.clone().sub(sampled.position).toArray();
        constraint.rotation_offset = sampled.quaternion.clone().invert().multiply(current.quaternion).normalize().toArray();
        constraint.scale_offset = [safeScaleRatio(current.scale.x, sampled.scale.x), safeScaleRatio(current.scale.y, sampled.scale.y), safeScaleRatio(current.scale.z, sampled.scale.z)];
        return true;
    };
    const applyActionConstraint = (bone, constraint, influence) => {
        normalizeActionConstraint(constraint);
        const currentAction = Animation.selected;
        if (!currentAction) return;
        if (!constraint.action_owner_uuid) constraint.action_owner_uuid = currentAction.uuid;
        if (constraint.action_owner_uuid !== currentAction.uuid || actionCreatesRecursion(currentAction.uuid, constraint.action_uuid)) return;
        const action = findAnimation(constraint.action_uuid);
        const driver = actionDriverValue(bone, constraint);
        const sampled = action && driver !== null && sampleActionTransform(action, bone, mapActionTime(constraint, driver));
        if (!sampled) return;
        const desired = {
            position: sampled.position.clone(),
            quaternion: sampled.quaternion.clone(),
            scale: sampled.scale.clone()
        };
        if (constraint.maintain_offset === true) {
            desired.position.add(new THREE.Vector3().fromArray(constraint.position_offset));
            desired.quaternion.multiply(new THREE.Quaternion().fromArray(constraint.rotation_offset)).normalize();
            desired.scale.multiply(new THREE.Vector3().fromArray(constraint.scale_offset));
        }
        const current = decompose(bone.mesh.matrix);
        const blended = blendTransform(current, desired, influence, {
            position: constraint.channels.position !== false,
            rotation: constraint.channels.rotation !== false,
            scale: constraint.channels.scale !== false,
            position_axes: constraint.position_axes,
            rotation_axes: constraint.rotation_axes,
            scale_axes: constraint.scale_axes
        });
        bone.mesh.matrix.copy(compose(blended));
        bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
        bone.mesh.rotation.setFromQuaternion(bone.mesh.quaternion, Format.euler_order || 'ZYX');
        bone.mesh.updateMatrixWorld(true);
    };
    const applyChildOf = (bone, constraint, influence) => {
        const target = findNode(constraint.target);
        if (!target || !target.mesh || target === bone) return;
        target.mesh.updateMatrixWorld(true);
        const offset = Array.isArray(constraint.inverse_matrix) && constraint.inverse_matrix.length === 16
            ? new THREE.Matrix4().fromArray(constraint.inverse_matrix)
            : target.mesh.matrixWorld.clone().invert().multiply(bone.mesh.matrixWorld);
        const desiredWorld = target.mesh.matrixWorld.clone().multiply(offset);
        const current = decompose(bone.mesh.matrix);
        const desired = decompose(localFromWorld(bone, desiredWorld));
        const blended = blendTransform(current, desired, influence);
        bone.mesh.matrix.copy(compose(blended));
        bone.mesh.matrix.decompose(bone.mesh.position, bone.mesh.quaternion, bone.mesh.scale);
        bone.mesh.updateMatrixWorld(true);
    };
    let applying = false;
    const applyConstraints = () => {
        if (applying || typeof Modes === 'undefined' || !Modes.animate || !Animation.selected) return;
        applying = true;
        try {
            if (typeof Canvas !== 'undefined' && Canvas.scene) Canvas.scene.updateMatrixWorld(true);
            const pending = ArmatureBone.all.filter(bone => getStack(bone).some(item => item && item.enabled !== false));
            const done = new Set();
            for (let pass = 0; pass < pending.length + 1; pass++) {
                let changed = false;
                pending.forEach(bone => {
                    if (done.has(bone.uuid)) return;
                    const dependencies = getStack(bone).flatMap(item => {
                        if (!item) return [];
                        if (['position_blend', 'rotation_blend', 'scale_blend', 'rotation_difference'].includes(item.type)) return [findNode(item.target_a), findNode(item.target_b)];
                        if (item.type === 'armature_blend') return (Array.isArray(item.entries) ? item.entries : []).map(entry => findNode(entry.target));
                        if (item.type === 'space_switch') return (Array.isArray(item.entries) ? item.entries : []).map(entry => findNode(entry.target));
                        if (['follow_path', 'clamp_to', 'spline_ik'].includes(item.type)) return (Array.isArray(item.path_points) ? item.path_points : []).map(point => findNode(point.target));
                        return [findNode(item.target)];
                    }).filter(target => target instanceof ArmatureBone && pending.includes(target));
                    if (dependencies.some(target => !done.has(target.uuid)) && pass < pending.length) return;
                    getStack(bone).forEach(constraint => {
                        if (!constraint || constraint.enabled === false) return;
                        const influence = influenceAt(bone, constraint);
                        if (influence <= 0) return;
                        if (constraint.type === 'action_constraint') applyActionConstraint(bone, constraint, influence);
                        else if (constraint.type === 'copy_channels') applyCopyChannels(bone, constraint, influence);
                        else if (constraint.type === 'copy_transform') applyCopyTransform(bone, constraint, influence);
                        else if (constraint.type === 'position_blend') applyPositionBlend(bone, constraint, influence);
                        else if (constraint.type === 'copy_quaternion') applyCopyQuaternion(bone, constraint, influence);
                        else if (constraint.type === 'rotation_blend') applyRotationBlend(bone, constraint, influence);
                        else if (constraint.type === 'scale_blend') applyScaleBlend(bone, constraint, influence);
                        else if (constraint.type === 'rotation_difference') applyRotationDifference(bone, constraint, influence);
                        else if (constraint.type === 'transform_mapping') applyTransformMapping(bone, constraint, influence);
                        else if (constraint.type === 'limit_transform') applyLimit(bone, constraint, influence);
                        else if (constraint.type === 'floor_drop') applyFloorDrop(bone, constraint, influence);
                        else if (constraint.type === 'shrinkwrap') applyShrinkwrap(bone, constraint, influence);
                        else if (constraint.type === 'floor') applyFloor(bone, constraint, influence);
                        else if (constraint.type === 'limit_distance') applyLimitDistance(bone, constraint, influence);
                        else if (constraint.type === 'pivot') applyPivot(bone, constraint, influence);
                        else if (constraint.type === 'clamp_to') applyClampTo(bone, constraint, influence);
                        else if (constraint.type === 'follow_path') applyFollowPath(bone, constraint, influence);
                        else if (constraint.type === 'spline_ik') applySplineIK(bone, constraint, influence, splineWrittenBones);
                        else if (constraint.type === 'track_to') applyTracking(bone, constraint, influence);
                        else if (constraint.type === 'maintain_volume') applyMaintainVolume(bone, constraint, influence);
                        else if (constraint.type === 'stretch_to') applyStretchTo(bone, constraint, influence);
                        else if (constraint.type === 'locked_track') applyTracking(bone, constraint, influence);
                        else if (constraint.type === 'damped_track') applyTracking(bone, constraint, influence);
                        else if (constraint.type === 'armature_blend') applyArmatureBlend(bone, constraint, influence);
                        else if (constraint.type === 'space_switch') applySpaceSwitch(bone, constraint, influence);
                        else if (constraint.type === 'child_of') applyChildOf(bone, constraint, influence);
                    });
                    done.add(bone.uuid);
                    changed = true;
                });
                if (!changed) break;
            }
        } finally {
            applying = false;
        }
    };
    const originalPreview = Animator.preview;
    const previewWithConstraints = function() {
        const result = originalPreview.apply(this, arguments);
        applyConstraints();
        return result;
    };
    Animator.preview = previewWithConstraints;
    const originalConstraintRaycast = typeof Preview !== 'undefined' ? Preview.prototype.raycast : null;
    let pickingTarget = null;
    const mutate = (bone, name, callback, undoData) => {
        if (!bone) return;
        let editing = false;
        try {
            Undo.initEdit(Object.assign({elements: [bone]}, undoData));
            editing = true;
            const next = cloneValue(getStack(bone));
            callback(next);
            bone.ef_constraints = next;
            Undo.finishEdit(name);
            editing = false;
        } catch (error) {
            if (editing && typeof Undo.cancelEdit === 'function') Undo.cancelEdit(true);
            throw error;
        }
        refresh();
        Animator.preview();
    };
    const createConstraint = type => {
        const bone = selectedBone();
        if (!bone) return;
        const target = allConstraintTargets().find(item => item !== bone && item.mesh);
        const copyChannel = ['copy_position', 'copy_rotation', 'copy_scale'].includes(type) && type.slice(5);
        const limitChannel = ['limit_position', 'limit_rotation', 'limit_scale'].includes(type) && type.slice(6);
        const requestedType = type === 'distance' ? 'limit_distance' : type;
        const runtimeType = copyChannel ? 'copy_channels' : limitChannel ? 'limit_transform' : requestedType;
        const base = {id: constraintId(), type: runtimeType, name: tl('ef.constraint.' + requestedType), enabled: true, target: target ? target.uuid : '', influence: 1};
        if (type === 'maintain_volume') {
            delete base.target;
            Object.assign(base, {main_axis: 'x', reference_scale: 1, mode: 'volume', exponent: 1, custom_x: 0, custom_y: 1, custom_z: 1, min_factor: 0, max_factor: 100, compensation_weight: 1});
            captureMaintainVolumeReference(bone, base);
        }
        if (copyChannel) Object.assign(base, {space: 'world', maintain_offset: false, position_offset: [0, 0, 0], rotation_offset: [0, 0, 0, 1], scale_offset: [1, 1, 1], axes: {position: copyChannel === 'position', rotation: copyChannel === 'rotation', scale: copyChannel === 'scale', position_axes: {x: true, y: true, z: true}, rotation_axes: {x: true, y: true, z: true}, scale_axes: {x: true, y: true, z: true}}});
        if (type === 'copy_transform') Object.assign(base, {source_space: 'world', target_space: 'world', mix_mode: 'replace', maintain_offset: false, offset_matrix: new THREE.Matrix4().toArray(), channels: {position: true, rotation: true, scale: true}, position_axes: {x: true, y: true, z: true}, rotation_axes: {x: true, y: true, z: true}, scale_axes: {x: true, y: true, z: true}});
        if (type === 'copy_quaternion') Object.assign(base, {source_space: 'world', target_space: 'world', maintain_offset: false, rotation_offset: [0, 0, 0, 1], invert_target: false, mix_mode: 'slerp'});
        if (type === 'position_blend') {
            const targets = ArmatureBone.all.filter(item => item !== bone);
            delete base.target;
            Object.assign(base, {target_a: targets[0] ? targets[0].uuid : '', target_b: targets[1] ? targets[1].uuid : '', source_space_a: 'world', source_space_b: 'world', target_space: 'world', blend_weight: 0.5, position_axes: {x: true, y: true, z: true}, invert_target_a: false, invert_target_b: false, maintain_offset: false, position_offset: [0, 0, 0]});
        }
        if (type === 'scale_blend') {
            const targets = ArmatureBone.all.filter(item => item !== bone);
            delete base.target;
            Object.assign(base, {target_a: targets[0] ? targets[0].uuid : '', target_b: targets[1] ? targets[1].uuid : '', source_space_a: 'world', source_space_b: 'world', target_space: 'world', blend_weight: 0.5, mix_mode: 'linear', scale_axes: {x: true, y: true, z: true}, reciprocal_target_a: false, reciprocal_target_b: false, maintain_offset: false, scale_offset: [1, 1, 1]});
        }
        if (type === 'rotation_blend' || type === 'rotation_difference') {
            const targets = ArmatureBone.all.filter(item => item !== bone);
            delete base.target;
            Object.assign(base, type === 'rotation_blend'
                ? {target_a: targets[0] ? targets[0].uuid : '', target_b: targets[1] ? targets[1].uuid : '', source_space_a: 'world', source_space_b: 'world', target_space: 'world', invert_target_a: false, invert_target_b: false, blend_weight: 0.5, mix_mode: 'slerp', maintain_offset: false, rotation_offset: [0, 0, 0, 1]}
                : {target_a: targets[0] ? targets[0].uuid : '', target_b: targets[1] ? targets[1].uuid : '', source_space_a: 'local', source_space_b: 'local', target_space: 'local', direction: 'a_to_b', application_mode: 'add', difference_strength: 1, maintain_offset: false, rotation_offset: [0, 0, 0, 1]});
        }
        if (type === 'transform_mapping') Object.assign(base, {source_channel: 'position', target_channel: 'position', source_space: 'local', target_space: 'local', axis_mapping: [0, 1, 2], from_min: [0, 0, 0], from_max: [1, 1, 1], to_min: [0, 0, 0], to_max: [1, 1, 1], extrapolate: false, mix_mode: 'replace'});
        if (type === 'action_constraint') {
            const action = (typeof Animation !== 'undefined' && Array.isArray(Animation.all) ? Animation.all : []).find(candidate => Animation.selected && !actionCreatesRecursion(Animation.selected.uuid, candidate.uuid));
            Object.assign(base, {action_owner_uuid: Animation.selected ? Animation.selected.uuid : '', action_uuid: action ? action.uuid : '', driver_channel: 'position', driver_axis: 'x', source_space: 'local', input_min: 0, input_max: 1, action_start: 0, action_end: action ? Number(action.length) || 0 : 1, mapping: 'clamp', reverse: false, channels: {position: true, rotation: true, scale: true}, position_axes: {x: true, y: true, z: true}, rotation_axes: {x: true, y: true, z: true}, scale_axes: {x: true, y: true, z: true}, maintain_offset: false, position_offset: [0, 0, 0], rotation_offset: [0, 0, 0, 1], scale_offset: [1, 1, 1]});
        }
        if (type === 'floor_drop') Object.assign(base, {drop_axis: '-y', direction_space: 'world', surface_offset: 0, max_distance: 0, mode: 'snap', position_weight: 1, align_rotation: false, up_axis: 'y', rotation_weight: 1, maintain_rotation_offset: false, rotation_offset: [0, 0, 0, 1]});
        if (type === 'shrinkwrap') Object.assign(base, {mode: 'nearest_surface', project_axis: '-y', direction_space: 'world', bidirectional: false, surface_offset: 0, max_distance: 0, position_weight: 1, align_rotation: false, up_axis: 'y', rotation_weight: 1, flip_normal: false, maintain_rotation_offset: false, rotation_offset: [0, 0, 0, 1]});
        if (type === 'floor') Object.assign(base, {axis: 'y', offset: 0, space: 'world', prevent_penetration: true});
        if (requestedType === 'limit_distance') {
            Object.assign(base, {mode: 'initial', distance: 0, initial_distance: 0, softness: 0});
            captureInitialDistance(bone, base);
            base.distance = base.initial_distance;
        }
        if (type === 'pivot') Object.assign(base, {axis: 'y', angle: 0, space: 'world', keep_radius: true, follow_rotation: false});
        if (type === 'clamp_to') {
            const targets = ArmatureBone.all.filter(item => item !== bone).slice(0, 2);
            delete base.target;
            Object.assign(base, {path_points: targets.map(item => ({id: pathPointId(), target: item.uuid})), driver_axis: 'x', owner_space: 'local', input_min: 0, input_max: 1, reverse: false, interpolation: 'linear', closed: false, offset: [0, 0, 0]});
        }
        if (type === 'follow_path') {
            const targets = ArmatureBone.all.filter(item => item !== bone).slice(0, 2);
            delete base.target;
            Object.assign(base, {path_points: targets.map(item => ({id: pathPointId(), target: item.uuid})), progress: 0, interpolation: 'linear', closed: false, offset: [0, 0, 0], follow_rotation: false, forward_axis: 'z', up_axis: 'y', bank: 0, position_weight: 1, rotation_weight: 1, maintain_rotation_offset: false, rotation_offset: [0, 0, 0, 1]});
        }
        if (type === 'spline_ik') {
            const targets = ArmatureBone.all.filter(item => item !== bone).slice(0, 2);
            delete base.target;
            Object.assign(base, {path_points: targets.map(item => ({id: pathPointId(), target: item.uuid})), chain_length: Math.min(3, collectSplineChain(bone, 0).length), interpolation: 'catmull_rom', closed: false, offset: [0, 0, 0], forward_axis: 'y', up_axis: 'z', roll: 0, root_follow: true, stretch: false, volume: false});
        }
        if (type === 'track_to') Object.assign(base, {track_axis: 'z', up_axis: 'y', up_space: 'world', maintain_offset: false, rotation_offset: [0, 0, 0, 1]});
        if (type === 'stretch_to') {
            Object.assign(base, {main_axis: 'y', up_axis: 'z', original_length: 0, rotation_weight: 1, stretch_weight: 1, min_stretch_ratio: 0, max_stretch_ratio: 100, volume_mode: 'preserve', volume_exponent: 1, maintain_offset: false, rotation_offset: [0, 0, 0, 1]});
            captureStretchTo(bone, base);
        }
        if (type === 'locked_track') Object.assign(base, {track_axis: 'z', lock_axis: 'y', maintain_offset: false, rotation_offset: [0, 0, 0, 1]});
        if (type === 'damped_track') Object.assign(base, {track_axis: 'z', damping_angle: 30, maintain_offset: false, rotation_offset: [0, 0, 0, 1]});
        if (limitChannel) Object.assign(base, {limit_channel: limitChannel, position_axes: [limitChannel === 'position', limitChannel === 'position', limitChannel === 'position'], position_min: [-16, -16, -16], position_max: [16, 16, 16], rotation_axes: [limitChannel === 'rotation', limitChannel === 'rotation', limitChannel === 'rotation'], rotation_min: [-180, -180, -180], rotation_max: [180, 180, 180], scale_axes: [limitChannel === 'scale', limitChannel === 'scale', limitChannel === 'scale'], scale_min: [0, 0, 0], scale_max: [4, 4, 4]});
        if (type === 'armature_blend') {
            delete base.target;
            const entry = {id: armatureEntryId(), target: target ? target.uuid : '', weight: 1, source_space: 'world', offset_matrix: new THREE.Matrix4().toArray()};
            Object.assign(base, {entries: [entry], target_space: 'world', normalize_weights: true, maintain_offset: false, channels: {position: true, rotation: true, scale: true}, position_axes: {x: true, y: true, z: true}, rotation_axes: {x: true, y: true, z: true}, scale_axes: {x: true, y: true, z: true}});
        }
        if (type === 'space_switch') {
            delete base.target;
            const entry = {id: spaceEntryId(), target: target ? target.uuid : '', weight: 1, offset_matrix: new THREE.Matrix4().toArray()};
            captureSpaceOffset(bone, entry);
            base.entries = [entry];
        }
        if (type === 'child_of') {
            if (target && target.mesh) {
                target.mesh.updateMatrixWorld(true);
                bone.mesh.updateMatrixWorld(true);
            }
            base.inverse_matrix = target && target.mesh ? target.mesh.matrixWorld.clone().invert().multiply(bone.mesh.matrixWorld).toArray() : new THREE.Matrix4().toArray();
        }
        mutate(bone, tl('ef.constraint.add_undo'), stack => stack.push(base));
    };
    const assignTarget = (bone, index, value, field) => {
        const target = findNode(value);
        mutate(bone, tl('ef.constraint.edit_undo'), stack => {
            const item = stack[index];
            if (!item) return;
            const targetField = ['position_blend', 'rotation_blend', 'scale_blend', 'rotation_difference'].includes(item.type) && ['target_a', 'target_b'].includes(field) ? field : 'target';
            item[targetField] = value;
            if (item.type === 'position_blend' && item.maintain_offset === true) capturePositionBlendOffset(bone, item);
            if (item.type === 'rotation_blend' && item.maintain_offset === true) captureRotationBlendOffset(bone, item);
            if (item.type === 'scale_blend' && item.maintain_offset === true) captureScaleBlendOffset(bone, item);
            if (item.type === 'action_constraint' && item.maintain_offset === true) captureActionOffset(bone, item);
            if (item.type === 'copy_channels') captureCopyChannelsOffset(bone, item);
            if (item.type === 'copy_transform' && item.maintain_offset === true) captureCopyTransformOffset(bone, item);
            if (item.type === 'limit_distance') captureInitialDistance(bone, item);
            if (item.type === 'copy_quaternion' && item.maintain_offset === true) captureQuaternionOffset(bone, item);
            if (item.type === 'floor_drop' && item.maintain_rotation_offset === true) captureFloorDropRotationOffset(bone, item);
            if (item.type === 'shrinkwrap' && item.maintain_rotation_offset === true) captureShrinkwrapRotationOffset(bone, item);
            if (['track_to', 'locked_track', 'damped_track'].includes(item.type) && item.maintain_offset === true) captureTrackOffset(bone, item);
            if (item.type === 'stretch_to') captureStretchTo(bone, item);
            if (item.type === 'child_of' && target && target.mesh) {
                target.mesh.updateMatrixWorld(true);
                bone.mesh.updateMatrixWorld(true);
                item.inverse_matrix = target.mesh.matrixWorld.clone().invert().multiply(bone.mesh.matrixWorld).toArray();
            }
        });
    };
    const assignArmatureTarget = (bone, constraintIndex, entryIndex, value) => {
        mutate(bone, tl('ef.constraint.edit_undo'), stack => {
            const constraint = stack[constraintIndex];
            const entry = constraint && Array.isArray(constraint.entries) && constraint.entries[entryIndex];
            if (!entry) return;
            entry.target = value;
            if (constraint.maintain_offset === true) captureArmatureOffset(bone, constraint, entry);
        });
    };
    const assignSpaceTarget = (bone, constraintIndex, entryIndex, value) => {
        mutate(bone, tl('ef.constraint.edit_undo'), stack => {
            const constraint = stack[constraintIndex];
            const entry = constraint && Array.isArray(constraint.entries) && constraint.entries[entryIndex];
            if (!entry) return;
            entry.target = value;
            captureSpaceOffset(bone, entry);
        });
    };
    const assignPathTarget = (bone, constraintIndex, pointIndex, value) => {
        mutate(bone, tl('ef.constraint.edit_undo'), stack => {
            const constraint = stack[constraintIndex];
            const point = constraint && Array.isArray(constraint.path_points) && constraint.path_points[pointIndex];
            if (!point) return;
            point.target = value;
            if (constraint.maintain_rotation_offset === true) capturePathRotationOffset(bone, constraint);
        });
    };
    if (originalConstraintRaycast) {
        Preview.prototype.raycast = function(event, options) {
            const hit = originalConstraintRaycast.call(this, event, options);
            if (!pickingTarget) return hit;
            const target = hit && hit.element;
            if (target && target !== pickingTarget.bone && findNode(target.uuid)) {
                if (Number.isInteger(pickingTarget.pointIndex)) assignPathTarget(pickingTarget.bone, pickingTarget.index, pickingTarget.pointIndex, target.uuid);
                else if (Number.isInteger(pickingTarget.armatureEntryIndex)) assignArmatureTarget(pickingTarget.bone, pickingTarget.index, pickingTarget.armatureEntryIndex, target.uuid);
                else if (Number.isInteger(pickingTarget.entryIndex)) assignSpaceTarget(pickingTarget.bone, pickingTarget.index, pickingTarget.entryIndex, target.uuid);
                else assignTarget(pickingTarget.bone, pickingTarget.index, target.uuid, pickingTarget.field);
                pickingTarget = null;
                return hit;
            }
            return hit;
        };
    }
    const sampleBone = bone => {
        const restRotation = bone.mesh.fix_rotation ? new THREE.Quaternion().setFromEuler(bone.mesh.fix_rotation) : new THREE.Quaternion();
        const delta = restRotation.invert().multiply(bone.mesh.quaternion.clone()).normalize();
        const euler = new THREE.Euler().setFromQuaternion(delta, Format.euler_order || 'ZYX');
        const restPosition = bone.mesh.fix_position || new THREE.Vector3().fromArray(bone.origin || [0, 0, 0]);
        return {
            position: bone.mesh.position.clone().sub(restPosition).toArray(),
            rotation: [Math.radToDeg(euler.x), Math.radToDeg(euler.y), Math.radToDeg(euler.z)],
            scale: bone.mesh.scale.toArray()
        };
    };
    const constraintBelongsToAnimation = (constraint, animation) => constraint.type !== 'action_constraint' || !constraint.action_owner_uuid || constraint.action_owner_uuid === animation.uuid;
    const bake = (bones, clear) => {
        const animation = Animation.selected;
        if (!animation) return Blockbench.showQuickMessage(tl('ef.constraint.nothing'));
        const requestedBones = new Set(bones);
        const requestedSplineBones = new Set(ArmatureBone.all.flatMap(owner => requestedBones.has(owner) ? getStack(owner).filter(constraint => constraintBelongsToAnimation(constraint, animation) && constraint.type === 'spline_ik').flatMap(constraint => collectSplineChain(owner, constraint.chain_length)) : []));
        bones = [...new Set([...bones, ...requestedSplineBones])].filter(bone => requestedSplineBones.has(bone) || getStack(bone).some(constraint => constraintBelongsToAnimation(constraint, animation)));
        if (!bones.length) return Blockbench.showQuickMessage(tl('ef.constraint.nothing'));
        const rate = Math.clamp(Number(animation.snapping) || 20, 1, 500);
        const bakeAction = globalThis.efBakeVisualAction;
        if (typeof bakeAction !== 'function') return Blockbench.showQuickMessage(tl('ef.constraint.nothing'));
        const armatureKeyData = clear ? bones.flatMap(bone => getStack(bone).filter(constraint => constraintBelongsToAnimation(constraint, animation) && constraint.type === 'armature_blend').map(constraint => getConstraintKeyframesAcrossAnimations(bone, constraint, constraint.entries))) : [];
        const constraintKeys = clear ? [...new Set([
            ...bones.flatMap(bone => getStack(bone).filter(constraint => constraintBelongsToAnimation(constraint, animation) && constraint.type !== 'armature_blend').flatMap(constraint => [
                ...getInfluenceKeyframes(bone, constraint),
                ...(constraint.type === 'follow_path' ? getPathProgressKeyframes(bone, constraint) : []),
                ...(constraint.type === 'space_switch' && Array.isArray(constraint.entries) ? constraint.entries.flatMap(entry => getSpaceWeightKeyframes(bone, constraint, entry)) : [])
            ])),
            ...armatureKeyData.flatMap(data => data.keyframes)
        ])] : [];
        const affectedAnimations = [...new Set([animation, ...armatureKeyData.flatMap(data => data.animations)])];
        const completed = bakeAction({
            nodes: bones,
            affected_elements: clear ? bones : [],
            affected_keyframes: constraintKeys,
            affected_animations: affectedAnimations,
            bake_data: 'pose',
            visual_keying: true,
            frame_start: 0,
            frame_end: Math.ceil((Number(animation.length) || 0) * rate),
            frame_step: 1,
            overwrite: true,
            clean_curves: true,
            clear_callback: clear ? () => {
                constraintKeys.forEach(keyframe => keyframe.remove());
                bones.forEach(bone => bone.ef_constraints = getStack(bone).filter(constraint => !constraintBelongsToAnimation(constraint, animation)));
            } : null,
            undo_name: tl('ef.constraint.bake_undo'),
            success_message: tl('ef.constraint.baked')
        });
        if (completed) refresh();
    };
    let panel;
    const panelComponent = {
        data() {
            return {bone: null, stack: [], targets: [], version: 0};
        },
        methods: {
            add(type) { createConstraint(type); },
            bakeSpline(index) { const item = this.bone && getStack(this.bone)[index]; if (!item || item.type !== 'spline_ik') return; const affected = new Set(collectSplineChain(this.bone, item.chain_length)); let changed = true; while (changed) { changed = false; ArmatureBone.all.forEach(owner => getStack(owner).filter(constraint => constraint.type === 'spline_ik' && constraint.enabled !== false).forEach(constraint => { const chain = collectSplineChain(owner, constraint.chain_length); if (!chain.some(bone => affected.has(bone))) return; chain.forEach(bone => { if (!affected.has(bone)) { affected.add(bone); changed = true; } }); })); } bake([...affected], false); },
            remove(index) {
                const bone = this.bone;
                const item = bone && getStack(bone)[index];
                const animation = Animation.selected;
                const allArmatureKeys = item && item.type === 'armature_blend' ? getConstraintKeyframesAcrossAnimations(bone, item, item.entries) : null;
                const keys = item ? allArmatureKeys ? allArmatureKeys.keyframes : [
                    ...getInfluenceKeyframes(bone, item),
                    ...(item.type === 'follow_path' ? getPathProgressKeyframes(bone, item) : []),
                    ...(item.type === 'space_switch' && Array.isArray(item.entries) ? item.entries.flatMap(entry => getSpaceWeightKeyframes(bone, item, entry)) : [])
                ] : [];
                mutate(bone, tl('ef.constraint.remove_undo'), stack => {
                    stack.splice(index, 1);
                    keys.forEach(keyframe => keyframe.remove());
                }, keys.length ? {animations: allArmatureKeys ? allArmatureKeys.animations : [animation], keyframes: keys} : undefined);
            },
            move(index, offset) { const bone = this.bone; mutate(bone, tl('ef.constraint.reorder_undo'), stack => { const item = stack.splice(index, 1)[0]; stack.splice(index + offset, 0, item); }); },
            toggle(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => stack[index].enabled = stack[index].enabled === false); },
            set(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { if (stack[index]) stack[index][field] = value; }); },
            setTarget(index, value, field) { assignTarget(this.bone, index, value, field); },
            actionOptions(item) { return availableActions(item); },
            setActionTarget(index, value) { assignTarget(this.bone, index, value); },
            pickActionTarget(index) { this.pickTarget(index); },
            setActionField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeActionConstraint(stack[index]); if (!item) return; if (field === 'action_uuid' && actionCreatesRecursion(item.action_owner_uuid, value)) return; item[field] = value; if (field === 'action_uuid') { const action = findAnimation(value); item.action_end = action ? Number(action.length) || 0 : item.action_end; } if (item.maintain_offset === true) captureActionOffset(bone, item); }); },
            setActionNumber(index, field, value) { const number = Number(value); if (!Number.isFinite(number)) return; this.setActionField(index, field, field === 'action_start' || field === 'action_end' ? Math.max(0, number) : number); },
            setActionChannel(index, channel, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeActionConstraint(stack[index]); if (item) item.channels[channel] = value; }); },
            setActionAxis(index, channel, axis, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeActionConstraint(stack[index]); if (item) item[channel + '_axes'][axis] = value; }); },
            setActionOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeActionConstraint(stack[index]); if (!item) return; item.maintain_offset = value; if (value) captureActionOffset(bone, item); else { item.position_offset = [0, 0, 0]; item.rotation_offset = [0, 0, 0, 1]; item.scale_offset = [1, 1, 1]; } }); },
            resetActionOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeActionConstraint(stack[index]); if (item) captureActionOffset(bone, item); }); },
            setCopySpace(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.space = value; captureCopyChannelsOffset(bone, item); }); },
            setMaintainOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.maintain_offset = value; if (value) captureCopyChannelsOffset(bone, item); }); },
            setCopyTransformField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item[field] = value; if (item.maintain_offset === true && ['source_space', 'target_space', 'mix_mode'].includes(field)) captureCopyTransformOffset(bone, item); }); },
            setCopyTransformOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.maintain_offset = value; if (value) captureCopyTransformOffset(bone, item); else item.offset_matrix = new THREE.Matrix4().toArray(); }); },
            resetCopyTransformOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) captureCopyTransformOffset(bone, item); }); },
            setCopyTransformChannel(index, channel, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; if (!item.channels) item.channels = {position: true, rotation: true, scale: true}; item.channels[channel] = value; }); },
            setCopyTransformAxis(index, channel, axis, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; const field = channel + '_axes'; if (!item[field]) item[field] = {x: true, y: true, z: true}; item[field][axis] = value; }); },
            setQuaternionField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item[field] = value; if (item.maintain_offset === true) captureQuaternionOffset(bone, item); }); },
            setQuaternionOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.maintain_offset = value; if (value) captureQuaternionOffset(bone, item); else item.rotation_offset = [0, 0, 0, 1]; }); },
            resetQuaternionOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) captureQuaternionOffset(bone, item); }); },
            setPositionBlendField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item[field] = field === 'blend_weight' ? THREE.MathUtils.clamp(Number(value), 0, 1) : value; if (item.maintain_offset === true) capturePositionBlendOffset(bone, item); }); },
            setPositionBlendAxis(index, axis, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; if (!item.position_axes) item.position_axes = {x: true, y: true, z: true}; item.position_axes[axis] = value; }); },
            setPositionBlendOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.maintain_offset = value; if (value) capturePositionBlendOffset(bone, item); else item.position_offset = [0, 0, 0]; }); },
            resetPositionBlendOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) capturePositionBlendOffset(bone, item); }); },
            setRotationBlendField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item[field] = value; if (item.maintain_offset === true) captureRotationBlendOffset(bone, item); }); },
            setRotationBlendOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.maintain_offset = value; if (value) captureRotationBlendOffset(bone, item); else item.rotation_offset = [0, 0, 0, 1]; }); },
            resetRotationBlendOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) captureRotationBlendOffset(bone, item); }); },
            setScaleBlendField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item[field] = field === 'blend_weight' ? THREE.MathUtils.clamp(Number(value), 0, 1) : value; if (item.maintain_offset === true) captureScaleBlendOffset(bone, item); }); },
            setScaleBlendAxis(index, axis, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; if (!item.scale_axes) item.scale_axes = {x: true, y: true, z: true}; item.scale_axes[axis] = value; }); },
            setScaleBlendOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.maintain_offset = value; if (value) captureScaleBlendOffset(bone, item); else item.scale_offset = [1, 1, 1]; }); },
            resetScaleBlendOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) captureScaleBlendOffset(bone, item); }); },
            setTrackField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item[field] = value; if (item.maintain_offset === true) captureTrackOffset(bone, item); }); },
            setDistanceValue(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeDistanceConstraint(stack[index]); if (item) item[field] = finiteNonNegative(value, 0); }); },
            setDistanceMode(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeDistanceConstraint(stack[index]); if (!item || !distanceModes.includes(value)) return; item.mode = value; if (value === 'initial') captureInitialDistance(bone, item); }); },
            resetInitialDistance(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeDistanceConstraint(stack[index]); if (item) captureInitialDistance(bone, item); }); },
            setFloorDropField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeFloorDrop(stack[index]); if (!item) return; item[field] = value; normalizeFloorDrop(item); if (item.maintain_rotation_offset === true && ['up_axis', 'direction_space', 'drop_axis'].includes(field)) captureFloorDropRotationOffset(bone, item); }); },
            setFloorDropNumber(index, field, value) { const number = Number(value); if (!Number.isFinite(number)) return; this.setFloorDropField(index, field, ['position_weight', 'rotation_weight'].includes(field) ? THREE.MathUtils.clamp(number, 0, 1) : field === 'max_distance' ? Math.max(0, number) : number); },
            setShrinkwrapField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeShrinkwrap(stack[index]); if (!item) return; item[field] = value; normalizeShrinkwrap(item); if (item.maintain_rotation_offset === true) captureShrinkwrapRotationOffset(bone, item); }); },
            setShrinkwrapNumber(index, field, value) { const number = Number(value); if (!Number.isFinite(number)) return; this.setShrinkwrapField(index, field, ['position_weight', 'rotation_weight'].includes(field) ? THREE.MathUtils.clamp(number, 0, 1) : field === 'max_distance' ? Math.max(0, number) : number); },
            setShrinkwrapRotationOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeShrinkwrap(stack[index]); if (!item) return; item.maintain_rotation_offset = value; if (value) captureShrinkwrapRotationOffset(bone, item); else item.rotation_offset = [0, 0, 0, 1]; }); },
            resetShrinkwrapRotationOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeShrinkwrap(stack[index]); if (item) captureShrinkwrapRotationOffset(bone, item); }); },
            setFloorDropRotationOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeFloorDrop(stack[index]); if (!item) return; item.maintain_rotation_offset = value; if (value) captureFloorDropRotationOffset(bone, item); else item.rotation_offset = [0, 0, 0, 1]; }); },
            resetFloorDropRotationOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeFloorDrop(stack[index]); if (item) captureFloorDropRotationOffset(bone, item); }); },
            setTrackOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.maintain_offset = value; if (value) captureTrackOffset(bone, item); else item.rotation_offset = [0, 0, 0, 1]; }); },
            resetTrackOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) captureTrackOffset(bone, item); }); },
            setMaintainVolumeAxis(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item || !['x', 'y', 'z'].includes(value)) return; item.main_axis = value; captureMaintainVolumeReference(bone, item); }); },
            setMaintainVolumeNumber(index, field, value) { const number = Number(value); if (!Number.isFinite(number)) return; const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; if (field === 'exponent') item[field] = THREE.MathUtils.clamp(number, 0, 2); else if (field === 'compensation_weight' || field.startsWith('custom_')) item[field] = THREE.MathUtils.clamp(number, 0, 1); else item[field] = Math.max(0, number); if (field === 'min_factor' || field === 'max_factor') { const minimum = finiteNonNegative(item.min_factor, 0); const maximum = finiteNonNegative(item.max_factor, 100); item.min_factor = Math.min(minimum, maximum); item.max_factor = Math.max(minimum, maximum); } }); },
            resetMaintainVolumeReference(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) captureMaintainVolumeReference(bone, item); }); },
            setStretchField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item[field] = value; if (['main_axis', 'up_axis', 'maintain_offset'].includes(field)) captureStretchTo(bone, item); }); },
            setStretchNumber(index, field, value) { const number = Number(value); if (!Number.isFinite(number)) return; const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; if (field === 'volume_exponent') { item[field] = THREE.MathUtils.clamp(number, 0, 1); return; } item[field] = Math.max(0, number); if (field === 'min_stretch_ratio' || field === 'max_stretch_ratio') { const minimum = finiteNonNegative(item.min_stretch_ratio, 0); const maximum = finiteNonNegative(item.max_stretch_ratio, 100); item.min_stretch_ratio = Math.min(minimum, maximum); item.max_stretch_ratio = Math.max(minimum, maximum); } }); },
            captureStretch(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) captureStretchTo(bone, item); }); },
            resetCopyOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) captureCopyChannelsOffset(bone, item); }); },
            pickTarget(index, field) { if (!this.bone || !this.stack[index]) return; pickingTarget = {bone: this.bone, index, field}; Blockbench.showQuickMessage(tl('ef.constraint.pick_target_hint')); },
            addPathPoint(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item || !['follow_path', 'clamp_to'].includes(item.type)) return; if (!Array.isArray(item.path_points)) item.path_points = []; const target = this.targets.find(candidate => !item.path_points.some(point => point.target === candidate.uuid)) || this.targets[0]; item.path_points.push({id: pathPointId(), target: target ? target.uuid : ''}); if (item.maintain_rotation_offset === true) capturePathRotationOffset(bone, item); }); },
            removePathPoint(index, pointIndex) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item || !Array.isArray(item.path_points)) return; item.path_points.splice(pointIndex, 1); if (item.maintain_rotation_offset === true) capturePathRotationOffset(bone, item); }); },
            movePathPoint(index, pointIndex, offset) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; const points = item && item.path_points; if (!Array.isArray(points)) return; const point = points.splice(pointIndex, 1)[0]; points.splice(pointIndex + offset, 0, point); if (item.maintain_rotation_offset === true) capturePathRotationOffset(bone, item); }); },
            setPathTarget(index, pointIndex, value) { assignPathTarget(this.bone, index, pointIndex, value); },
            pathValid(item) { const valid = new Set((item && Array.isArray(item.path_points) ? item.path_points : []).map(point => point.target).filter(uuid => uuid && this.targets.some(target => target.uuid === uuid))); return valid.size >= 2; },
            pickPathTarget(index, pointIndex) { if (!this.bone || !this.stack[index]) return; pickingTarget = {bone: this.bone, index, pointIndex}; Blockbench.showQuickMessage(tl('ef.constraint.pick_target_hint')); },
            setPathField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item[field] = value; if (item.maintain_rotation_offset === true && ['interpolation', 'closed', 'forward_axis', 'up_axis', 'bank'].includes(field)) capturePathRotationOffset(bone, item); }); },
            setPathNumber(index, field, value) { const number = Number(value); if (!Number.isFinite(number)) return; const normalized = ['progress', 'position_weight', 'rotation_weight'].includes(field) ? THREE.MathUtils.clamp(number, 0, 1) : number; this.setPathField(index, field, normalized); },
            captureClampInput(index, field) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = normalizeFollowPath(stack[index]); if (!item || item.type !== 'clamp_to') return; bone.mesh.updateMatrixWorld(true); const position = item.owner_space === 'world' ? bone.mesh.getWorldPosition(new THREE.Vector3()) : bone.mesh.position; const axis = item.driver_axis.replace('-', ''); const sign = item.driver_axis.startsWith('-') ? -1 : 1; item[field] = position[axis] * sign; }); },
            setPathOffset(index, axis, value) { const number = Number(value); if (!Number.isFinite(number)) return; const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; if (!Array.isArray(item.offset)) item.offset = [0, 0, 0]; item.offset[axis] = number; }); },
            setPathRotationOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.maintain_rotation_offset = value; if (value) capturePathRotationOffset(bone, item); else item.rotation_offset = [0, 0, 0, 1]; }); },
            resetPathRotationOffset(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) capturePathRotationOffset(bone, item); }); },
            addSpaceEntry(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item || item.type !== 'space_switch') return; if (!Array.isArray(item.entries)) item.entries = []; const target = this.targets.find(candidate => !item.entries.some(entry => entry.target === candidate.uuid)) || this.targets[0]; const entry = {id: spaceEntryId(), target: target ? target.uuid : '', weight: 0, offset_matrix: new THREE.Matrix4().toArray()}; captureSpaceOffset(bone, entry); item.entries.push(entry); }); },
            removeSpaceEntry(index, entryIndex) { const bone = this.bone; const item = bone && getStack(bone)[index]; const entry = item && item.entries && item.entries[entryIndex]; const animation = Animation.selected; const keys = entry ? getSpaceWeightKeyframes(bone, item, entry) : []; mutate(bone, tl('ef.constraint.edit_undo'), stack => { if (stack[index] && Array.isArray(stack[index].entries)) stack[index].entries.splice(entryIndex, 1); keys.forEach(keyframe => keyframe.remove()); }, animation && keys.length ? {animations: [animation], keyframes: keys} : undefined); },
            moveSpaceEntry(index, entryIndex, offset) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const entries = stack[index] && stack[index].entries; if (!Array.isArray(entries)) return; const entry = entries.splice(entryIndex, 1)[0]; entries.splice(entryIndex + offset, 0, entry); }); },
            setSpaceTarget(index, entryIndex, value) { assignSpaceTarget(this.bone, index, entryIndex, value); },
            pickSpaceTarget(index, entryIndex) { if (!this.bone || !this.stack[index]) return; pickingTarget = {bone: this.bone, index, entryIndex}; Blockbench.showQuickMessage(tl('ef.constraint.pick_target_hint')); },
            setSpaceWeight(index, entryIndex, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const entry = stack[index] && stack[index].entries && stack[index].entries[entryIndex]; if (entry) entry.weight = THREE.MathUtils.clamp(Number(value), 0, 1); }); },
            captureSpaceEntry(index, entryIndex) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const entry = stack[index] && stack[index].entries && stack[index].entries[entryIndex]; if (entry) captureSpaceOffset(bone, entry); }); },
            switchToSpace(index, entryIndex) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; const entry = item && item.entries && item.entries[entryIndex]; if (!entry || !captureSpaceOffset(bone, entry)) return; item.entries.forEach((candidate, candidateIndex) => candidate.weight = candidateIndex === entryIndex ? 1 : 0); }); },
            addArmatureEntry(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item || item.type !== 'armature_blend') return; const target = this.targets.find(candidate => !item.entries.some(entry => entry.target === candidate.uuid)) || this.targets[0]; const entry = {id: armatureEntryId(), target: target ? target.uuid : '', weight: 0, source_space: 'world', offset_matrix: new THREE.Matrix4().toArray()}; if (item.maintain_offset === true) captureArmatureOffset(bone, item, entry); item.entries.push(entry); }); },
            removeArmatureEntry(index, entryIndex) { const bone = this.bone; const item = bone && getStack(bone)[index]; const entry = item && item.entries && item.entries[entryIndex]; const allKeys = entry ? getConstraintKeyframesAcrossAnimations(bone, item, [entry]) : {animations: [], keyframes: []}; const influenceKeys = new Set(getConstraintKeyframesAcrossAnimations(bone, item, []).keyframes); const keys = allKeys.keyframes.filter(keyframe => !influenceKeys.has(keyframe)); mutate(bone, tl('ef.constraint.edit_undo'), stack => { if (stack[index] && Array.isArray(stack[index].entries)) stack[index].entries.splice(entryIndex, 1); keys.forEach(keyframe => keyframe.remove()); }, keys.length ? {animations: allKeys.animations, keyframes: keys} : undefined); },
            moveArmatureEntry(index, entryIndex, offset) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const entries = stack[index] && stack[index].entries; if (!Array.isArray(entries)) return; const entry = entries.splice(entryIndex, 1)[0]; entries.splice(entryIndex + offset, 0, entry); }); },
            setArmatureTarget(index, entryIndex, value) { assignArmatureTarget(this.bone, index, entryIndex, value); },
            pickArmatureTarget(index, entryIndex) { if (!this.bone || !this.stack[index]) return; pickingTarget = {bone: this.bone, index, armatureEntryIndex: entryIndex}; Blockbench.showQuickMessage(tl('ef.constraint.pick_target_hint')); },
            setArmatureWeight(index, entryIndex, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const entry = stack[index] && stack[index].entries && stack[index].entries[entryIndex]; if (entry) entry.weight = THREE.MathUtils.clamp(Number(value), 0, 1); }); },
            setArmatureSourceSpace(index, entryIndex, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; const entry = item && item.entries && item.entries[entryIndex]; if (!entry) return; entry.source_space = value === 'local' ? 'local' : 'world'; if (item.maintain_offset === true) captureArmatureOffset(bone, item, entry); }); },
            setArmatureField(index, field, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item[field] = value; if (item.maintain_offset === true && field === 'target_space') item.entries.forEach(entry => captureArmatureOffset(bone, item, entry)); }); },
            setArmatureChannel(index, channel, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) item.channels[channel] = value; }); },
            setArmatureAxis(index, channel, axis, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) item[channel + '_axes'][axis] = value; }); },
            setArmatureOffset(index, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item) return; item.maintain_offset = value; item.entries.forEach(entry => entry.offset_matrix = value && captureArmatureOffset(bone, item, entry) ? entry.offset_matrix : new THREE.Matrix4().toArray()); }); },
            captureArmatureEntry(index, entryIndex) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; const entry = item && item.entries && item.entries[entryIndex]; if (entry) captureArmatureOffset(bone, item, entry); }); },
            captureAllArmatureOffsets(index) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (item) item.entries.forEach(entry => captureArmatureOffset(bone, item, entry)); }); },
            setNumber(index, field, value) { this.set(index, field, THREE.MathUtils.clamp(Number(value), 0, 1)); },
            setVector(index, field, axis, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const item = stack[index]; if (!item || !Array.isArray(item[field])) return; const number = Number(value); if (!Number.isFinite(number)) return; item[field][axis] = field === 'scale_min' || field === 'scale_max' ? Math.max(0, number) : number; if (field === 'scale_min' || field === 'scale_max') { const min = finiteNonNegative(item.scale_min[axis], 0); const max = finiteNonNegative(item.scale_max[axis], 0); item.scale_min[axis] = Math.min(min, max); item.scale_max[axis] = Math.max(min, max); } }); },
            setMappingAxis(index, axis, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { if (stack[index] && Array.isArray(stack[index].axis_mapping)) stack[index].axis_mapping[axis] = Number(value); }); },
            setAxis(index, field, axis, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { if (stack[index] && stack[index][field]) stack[index][field][axis] = value; }); },
            setCopyAxis(index, channel, axis, value) { const bone = this.bone; mutate(bone, tl('ef.constraint.edit_undo'), stack => { const axes = stack[index] && stack[index].axes; if (axes && axes[channel + '_axes']) axes[channel + '_axes'][axis] = value; }); },
            keyArmatureWeight(index, entryIndex) {
                const bone = this.bone;
                const item = bone && getStack(bone)[index];
                const entry = item && item.entries && item.entries[entryIndex];
                const animation = Animation.selected;
                if (!bone || !item || !entry || !animation) return;
                const animator = animation.getBoneAnimator(bone);
                if (!animator.group) animator.group = bone;
                const channel = ensureArmatureWeightChannel(animator, item, entry);
                const time = Number(Timeline.time) || 0;
                const existing = getArmatureWeightKeyframes(bone, item, entry).find(keyframe => Math.abs(keyframe.time - time) < 0.000001);
                let editing = false;
                try {
                    Undo.initEdit({animations: [animation], keyframes: existing ? [existing] : []});
                    editing = true;
                    const value = THREE.MathUtils.clamp(Number(entry.weight), 0, 1);
                    const keyframe = existing || animator.createKeyframe({x: value, y: 0, z: 0}, time, channel, false, false);
                    keyframe.ef_constraint_id = item.id;
                    if (existing) keyframe.set('x', value);
                    animator.addToTimeline();
                    Undo.finishEdit(tl('ef.constraint.key_undo'), {animations: [animation], keyframes: [keyframe]});
                    editing = false;
                } catch (error) {
                    if (editing && typeof Undo.cancelEdit === 'function') Undo.cancelEdit(true);
                    throw error;
                }
                Animator.preview();
            },
            keySpaceWeight(index, entryIndex) {
                const bone = this.bone;
                const item = bone && getStack(bone)[index];
                const entry = item && item.entries && item.entries[entryIndex];
                const animation = Animation.selected;
                if (!bone || !item || !entry || !animation) return;
                const animator = animation.getBoneAnimator(bone);
                if (!animator.group) animator.group = bone;
                const channel = ensureSpaceWeightChannel(animator, item, entry);
                const time = Number(Timeline.time) || 0;
                const existing = getSpaceWeightKeyframes(bone, item, entry).find(keyframe => Math.abs(keyframe.time - time) < 0.000001);
                let editing = false;
                try {
                    Undo.initEdit({animations: [animation], keyframes: existing ? [existing] : []});
                    editing = true;
                    const value = THREE.MathUtils.clamp(Number(entry.weight), 0, 1);
                    const keyframe = existing || animator.createKeyframe({x: value, y: 0, z: 0}, time, channel, false, false);
                    keyframe.ef_constraint_id = item.id;
                    if (existing) keyframe.set('x', value);
                    animator.addToTimeline();
                    Undo.finishEdit(tl('ef.constraint.key_undo'), {animations: [animation], keyframes: [keyframe]});
                    editing = false;
                } catch (error) {
                    if (editing && typeof Undo.cancelEdit === 'function') Undo.cancelEdit(true);
                    throw error;
                }
                Animator.preview();
            },
            keyPathProgress(index) {
                const bone = this.bone;
                const item = bone && getStack(bone)[index];
                const animation = Animation.selected;
                if (!bone || !item || item.type !== 'follow_path' || !animation) return;
                const animator = animation.getBoneAnimator(bone);
                if (!animator.group) animator.group = bone;
                const channel = ensurePathProgressChannel(animator, item);
                const time = Number(Timeline.time) || 0;
                const existing = getPathProgressKeyframes(bone, item).find(keyframe => Math.abs(keyframe.time - time) < 0.000001);
                let editing = false;
                try {
                    Undo.initEdit({animations: [animation], keyframes: existing ? [existing] : []});
                    editing = true;
                    const value = THREE.MathUtils.clamp(Number(item.progress), 0, 1);
                    const keyframe = existing || animator.createKeyframe({x: value, y: 0, z: 0}, time, channel, false, false);
                    keyframe.ef_constraint_id = item.id;
                    if (existing) keyframe.set('x', value);
                    animator.addToTimeline();
                    Undo.finishEdit(tl('ef.constraint.key_undo'), {animations: [animation], keyframes: [keyframe]});
                    editing = false;
                } catch (error) {
                    if (editing && typeof Undo.cancelEdit === 'function') Undo.cancelEdit(true);
                    throw error;
                }
                Animator.preview();
            },
            keyInfluence(index) {
                const bone = this.bone;
                const item = bone && getStack(bone)[index];
                const animation = Animation.selected;
                if (!bone || !item || !animation) return;
                const animator = animation.getBoneAnimator(bone);
                if (!animator.group) animator.group = bone;
                const channel = ensureInfluenceChannel(animator, item);
                const time = Number(Timeline.time) || 0;
                const existing = getInfluenceKeyframes(bone, item).find(keyframe => Math.abs(keyframe.time - time) < 0.000001);
                const undoKeyframes = existing ? [existing] : [];
                let editing = false;
                try {
                    Undo.initEdit({animations: [animation], keyframes: undoKeyframes});
                    editing = true;
                    const keyframe = existing || animator.createKeyframe({x: THREE.MathUtils.clamp(Number(item.influence), 0, 1), y: 0, z: 0}, time, channel, false, false);
                    keyframe.ef_constraint_id = item.id;
                    if (existing) keyframe.set('x', THREE.MathUtils.clamp(Number(item.influence), 0, 1));
                    animator.addToTimeline();
                    Undo.finishEdit(tl('ef.constraint.key_undo'), {animations: [animation], keyframes: [keyframe]});
                    editing = false;
                } catch (error) {
                    if (editing && typeof Undo.cancelEdit === 'function') Undo.cancelEdit(true);
                    throw error;
                }
                Animator.preview();
            },
            setInverse(index) { const bone = this.bone; const target = findNode(this.stack[index].target); if (!bone || !target || !target.mesh || !bone.mesh) return; target.mesh.updateMatrixWorld(true); bone.mesh.updateMatrixWorld(true); mutate(bone, tl('ef.constraint.edit_undo'), stack => { if (stack[index]) stack[index].inverse_matrix = target.mesh.matrixWorld.clone().invert().multiply(bone.mesh.matrixWorld).toArray(); }); },
            bakeSelected(clear) { if (this.bone) bake([this.bone], clear); },
            bakeAll(clear) { bake(ArmatureBone.all.slice(), clear); }
        },
        template: `<div class="ef_constraint_panel">
            <div v-if="!bone" class="ef_constraint_empty">{{ tl('ef.constraint.select_bone') }}</div>
            <template v-else>
                <div class="ef_constraint_owner">{{ bone.name }}</div>
                <div class="ef_constraint_add"><details open><summary>{{ tl('ef.constraint.group_transform') }}</summary><div class="ef_constraint_group"><button :title="tl('ef.constraint.copy_transform.desc')" @click="add('copy_transform')">{{ tl('ef.constraint.copy_transform') }}</button><button :title="tl('ef.constraint.copy_position.desc')" @click="add('copy_position')">{{ tl('ef.constraint.copy_position') }}</button><button :title="tl('ef.constraint.copy_rotation.desc')" @click="add('copy_rotation')">{{ tl('ef.constraint.copy_rotation') }}</button><button :title="tl('ef.constraint.copy_scale.desc')" @click="add('copy_scale')">{{ tl('ef.constraint.copy_scale') }}</button><button :title="tl('ef.constraint.copy_quaternion.desc')" @click="add('copy_quaternion')">{{ tl('ef.constraint.copy_quaternion') }}</button><button :title="tl('ef.constraint.transform_mapping.desc')" @click="add('transform_mapping')">{{ tl('ef.constraint.transform_mapping') }}</button></div></details><details open><summary>{{ tl('ef.constraint.group_blend') }}</summary><div class="ef_constraint_group"><button :title="tl('ef.constraint.position_blend.desc')" @click="add('position_blend')">{{ tl('ef.constraint.position_blend') }}</button><button :title="tl('ef.constraint.rotation_blend.desc')" @click="add('rotation_blend')">{{ tl('ef.constraint.rotation_blend') }}</button><button :title="tl('ef.constraint.scale_blend.desc')" @click="add('scale_blend')">{{ tl('ef.constraint.scale_blend') }}</button><button :title="tl('ef.constraint.rotation_difference.desc')" @click="add('rotation_difference')">{{ tl('ef.constraint.rotation_difference') }}</button></div></details><details open><summary>{{ tl('ef.constraint.group_limit') }}</summary><div class="ef_constraint_group"><button :title="tl('ef.constraint.limit_position.desc')" @click="add('limit_position')">{{ tl('ef.constraint.limit_position') }}</button><button :title="tl('ef.constraint.limit_rotation.desc')" @click="add('limit_rotation')">{{ tl('ef.constraint.limit_rotation') }}</button><button :title="tl('ef.constraint.limit_scale.desc')" @click="add('limit_scale')">{{ tl('ef.constraint.limit_scale') }}</button><button :title="tl('ef.constraint.limit_distance.desc')" @click="add('limit_distance')">{{ tl('ef.constraint.limit_distance') }}</button><button :title="tl('ef.constraint.floor.desc')" @click="add('floor')">{{ tl('ef.constraint.floor') }}</button><button :title="tl('ef.constraint.floor_drop.desc')" @click="add('floor_drop')">{{ tl('ef.constraint.floor_drop') }}</button><button :title="tl('ef.constraint.shrinkwrap.desc')" @click="add('shrinkwrap')">{{ tl('ef.constraint.shrinkwrap') }}</button></div></details><details open><summary>{{ tl('ef.constraint.group_track') }}</summary><div class="ef_constraint_group"><button :title="tl('ef.constraint.track_to.desc')" @click="add('track_to')">{{ tl('ef.constraint.track_to') }}</button><button :title="tl('ef.constraint.locked_track.desc')" @click="add('locked_track')">{{ tl('ef.constraint.locked_track') }}</button><button :title="tl('ef.constraint.damped_track.desc')" @click="add('damped_track')">{{ tl('ef.constraint.damped_track') }}</button><button :title="tl('ef.constraint.follow_path.desc')" @click="add('follow_path')">{{ tl('ef.constraint.follow_path') }}</button><button :title="tl('ef.constraint.spline_ik.desc')" @click="add('spline_ik')">{{ tl('ef.constraint.spline_ik') }}</button><button :title="tl('ef.constraint.clamp_to.desc')" @click="add('clamp_to')">{{ tl('ef.constraint.clamp_to') }}</button><button :title="tl('ef.constraint.stretch_to.desc')" @click="add('stretch_to')">{{ tl('ef.constraint.stretch_to') }}</button></div></details><details open><summary>{{ tl('ef.constraint.group_relation') }}</summary><div class="ef_constraint_group"><button :title="tl('ef.constraint.child_of.desc')" @click="add('child_of')">{{ tl('ef.constraint.child_of') }}</button><button :title="tl('ef.constraint.space_switch.desc')" @click="add('space_switch')">{{ tl('ef.constraint.space_switch') }}</button><button :title="tl('ef.constraint.armature_blend.desc')" @click="add('armature_blend')">{{ tl('ef.constraint.armature_blend') }}</button><button :title="tl('ef.constraint.action_constraint.desc')" @click="add('action_constraint')">{{ tl('ef.constraint.action_constraint') }}</button></div></details><details open><summary>{{ tl('ef.constraint.group_advanced') }}</summary><div class="ef_constraint_group"><button :title="tl('ef.constraint.maintain_volume.desc')" @click="add('maintain_volume')">{{ tl('ef.constraint.maintain_volume') }}</button><button :title="tl('ef.constraint.pivot.desc')" @click="add('pivot')">{{ tl('ef.constraint.pivot') }}</button></div></details>
                <div class="ef_constraint_stack">
                    <div class="ef_constraint_card" v-for="(item, index) in stack" :key="item.id">
                        <div class="ef_constraint_head"><button :title="item.enabled === false ? tl('ef.constraint.enable') : tl('ef.constraint.disable')" @click="toggle(index)">{{ item.enabled === false ? '○' : '●' }}</button><strong>{{ item.name }}</strong><span></span><button :title="tl('ef.constraint.move_up')" :disabled="index === 0" @click="move(index, -1)">↑</button><button :title="tl('ef.constraint.move_down')" :disabled="index === stack.length - 1" @click="move(index, 1)">↓</button><button :title="tl('ef.constraint.remove')" @click="remove(index)">×</button></div>
                        <label v-if="!['action_constraint', 'limit_transform', 'position_blend', 'rotation_blend', 'scale_blend', 'rotation_difference', 'maintain_volume', 'armature_blend', 'space_switch', 'follow_path', 'clamp_to'].includes(item.type)" :title="tl(item.type === 'floor_drop' ? 'ef.constraint.floor_drop_target.desc' : 'ef.constraint.target.desc')">{{ tl('ef.constraint.target') }}<select :value="item.target" @change="setTarget(index, $event.target.value)"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickTarget(index)">⌖</button></label>
                        <label :title="tl('ef.constraint.influence.desc')">{{ tl('ef.ik.influence') }}<input type="number" min="0" max="1" step="0.01" :value="item.influence" @change="setNumber(index, 'influence', $event.target.value)"><button :title="tl('ef.constraint.key_influence')" @click="keyInfluence(index)">◆</button></label>
                        <template v-if="['follow_path', 'clamp_to', 'spline_ik'].includes(item.type)"><div class="ef_constraint_path_header"><b :title="tl('ef.constraint.path_points.desc')">{{ tl('ef.constraint.path_points') }}</b><button :title="tl('ef.constraint.path_points.desc')" @click="addPathPoint(index)">{{ tl('ef.constraint.add_path_point') }}</button></div><div class="ef_constraint_path_warning" v-if="!pathValid(item)">{{ tl('ef.constraint.valid_path_required') }}</div><div class="ef_constraint_path_points"><div class="ef_constraint_path_point" v-for="(point, pointIndex) in item.path_points" :key="point.id"><div class="ef_constraint_path_point_head"><b>{{ tl('ef.constraint.path_point') }} {{ pointIndex + 1 }}</b><span></span><button :title="tl('ef.constraint.move_up')" :disabled="pointIndex === 0" @click="movePathPoint(index, pointIndex, -1)">↑</button><button :title="tl('ef.constraint.move_down')" :disabled="pointIndex === item.path_points.length - 1" @click="movePathPoint(index, pointIndex, 1)">↓</button><button :title="tl('ef.constraint.remove_path_point')" @click="removePathPoint(index, pointIndex)">×</button></div><label :title="tl('ef.constraint.path_point.desc')">{{ tl('ef.constraint.target') }}<select :value="point.target" @change="setPathTarget(index, pointIndex, $event.target.value)"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickPathTarget(index, pointIndex)">⌖</button></label></div></div><div class="ef_constraint_path_options"><label v-if="item.type === 'clamp_to'" :title="tl('ef.constraint.clamp_driver_axis.desc')">{{ tl('ef.constraint.driver_axis') }}<select :value="item.driver_axis" @change="setPathField(index, 'driver_axis', $event.target.value)"><option v-for="axis in ['x','-x','y','-y','z','-z']" :value="axis">{{ axis.toUpperCase() }}</option></select></label><label v-if="item.type === 'clamp_to'" :title="tl('ef.constraint.owner_space.desc')">{{ tl('ef.constraint.owner_space') }}<select :value="item.owner_space" @change="setPathField(index, 'owner_space', $event.target.value)"><option value="local">{{ tl('ef.constraint.local') }}</option><option value="world">{{ tl('ef.constraint.world') }}</option></select></label><label v-if="item.type === 'clamp_to'" :title="tl('ef.constraint.clamp_input_range.desc')">{{ tl('ef.constraint.input_min') }}<input type="number" step="0.1" :value="item.input_min" @change="setPathNumber(index, 'input_min', $event.target.value)"><button :title="tl('ef.constraint.capture_input_range.desc')" @click="captureClampInput(index, 'input_min')">⌖</button></label><label v-if="item.type === 'clamp_to'" :title="tl('ef.constraint.clamp_input_range.desc')">{{ tl('ef.constraint.input_max') }}<input type="number" step="0.1" :value="item.input_max" @change="setPathNumber(index, 'input_max', $event.target.value)"><button :title="tl('ef.constraint.capture_input_range.desc')" @click="captureClampInput(index, 'input_max')">⌖</button></label><label v-if="item.type === 'clamp_to'" :title="tl('ef.constraint.clamp_reverse.desc')"><input type="checkbox" :checked="item.reverse === true" @change="setPathField(index, 'reverse', $event.target.checked)">{{ tl('ef.constraint.reverse') }}</label><label v-if="item.type === 'follow_path'" :title="tl('ef.constraint.progress.desc')">{{ tl('ef.constraint.progress') }}<input type="number" min="0" max="1" step="0.01" :value="item.progress" @change="setPathNumber(index, 'progress', $event.target.value)"><button :title="tl('ef.constraint.key_progress')" @click="keyPathProgress(index)">◆</button></label><label :title="tl('ef.constraint.interpolation.desc')">{{ tl('ef.constraint.interpolation') }}<select :value="item.interpolation" @change="setPathField(index, 'interpolation', $event.target.value)"><option value="linear">{{ tl('ef.constraint.linear') }}</option><option value="catmull_rom">{{ tl('ef.constraint.catmull_rom') }}</option></select></label><label :title="tl('ef.constraint.closed.desc')"><input type="checkbox" :checked="item.closed === true" @change="setPathField(index, 'closed', $event.target.checked)">{{ tl('ef.constraint.closed') }}</label><label v-if="item.type === 'follow_path'" :title="tl('ef.constraint.position_weight.desc')">{{ tl('ef.constraint.position_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.position_weight" @change="setPathNumber(index, 'position_weight', $event.target.value)"></label></div><div class="ef_constraint_path_offset" :title="tl('ef.constraint.path_offset.desc')"><b>{{ tl('ef.constraint.offset') }}</b><label v-for="axis in [0,1,2]">{{ ['X','Y','Z'][axis] }}<input type="number" step="0.1" :value="item.offset[axis]" @change="setPathOffset(index, axis, $event.target.value)"></label></div><label v-if="item.type === 'follow_path'" :title="tl('ef.constraint.follow_path_rotation.desc')"><input type="checkbox" :checked="item.follow_rotation === true" @change="setPathField(index, 'follow_rotation', $event.target.checked)">{{ tl('ef.constraint.follow_rotation') }}</label><div class="ef_constraint_path_rotation" v-if="item.type === 'follow_path' && item.follow_rotation === true"><label :title="tl('ef.constraint.forward_axis.desc')">{{ tl('ef.constraint.forward_axis') }}<select :value="item.forward_axis" @change="setPathField(index, 'forward_axis', $event.target.value)"><option v-for="axis in ['x','-x','y','-y','z','-z']" :value="axis" :disabled="item.up_axis === axis.replace('-', '')">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.path_up_axis.desc')">{{ tl('ef.constraint.up_axis') }}<select :value="item.up_axis" @change="setPathField(index, 'up_axis', $event.target.value)"><option v-for="axis in ['x','y','z']" :value="axis" :disabled="item.forward_axis.replace('-', '') === axis">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.bank.desc')">{{ tl('ef.constraint.bank') }}<input type="number" step="1" :value="item.bank" @change="setPathNumber(index, 'bank', $event.target.value)"></label><label :title="tl('ef.constraint.path_rotation_weight.desc')">{{ tl('ef.constraint.rotation_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.rotation_weight" @change="setPathNumber(index, 'rotation_weight', $event.target.value)"></label></div><label v-if="item.type === 'follow_path' && item.follow_rotation === true" :title="tl('ef.constraint.maintain_rotation_offset.desc')"><input type="checkbox" :checked="item.maintain_rotation_offset === true" @change="setPathRotationOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_rotation_offset') }}<button :title="tl('ef.constraint.maintain_rotation_offset.desc')" :disabled="!item.maintain_rotation_offset" @click="resetPathRotationOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <div v-if="item.type === 'spline_ik'" class="ef_constraint_path_rotation"><label :title="tl('ef.constraint.forward_axis.desc')">{{ tl('ef.constraint.forward_axis') }}<select :value="item.forward_axis" @change="setPathField(index, 'forward_axis', $event.target.value)"><option v-for="axis in ['x','-x','y','-y','z','-z']" :value="axis" :disabled="item.up_axis === axis.replace('-', '')">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.path_up_axis.desc')">{{ tl('ef.constraint.up_axis') }}<select :value="item.up_axis" @change="setPathField(index, 'up_axis', $event.target.value)"><option v-for="axis in ['x','y','z']" :value="axis" :disabled="item.forward_axis.replace('-', '') === axis">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.roll.desc')">{{ tl('ef.constraint.roll') }}<input type="number" step="1" :value="item.roll" @change="setPathNumber(index, 'roll', $event.target.value)"></label><label :title="tl('ef.constraint.root_follow.desc')"><input type="checkbox" :checked="item.root_follow !== false" @change="setPathField(index, 'root_follow', $event.target.checked)">{{ tl('ef.constraint.root_follow') }}</label><label :title="tl('ef.constraint.stretch.desc')"><input type="checkbox" :checked="item.stretch === true" @change="setPathField(index, 'stretch', $event.target.checked)">{{ tl('ef.constraint.stretch') }}</label><label :title="tl('ef.constraint.volume.desc')"><input type="checkbox" :checked="item.volume === true" @change="setPathField(index, 'volume', $event.target.checked)">{{ tl('ef.constraint.volume') }}</label><button :title="tl('ef.constraint.spline_bake.desc')" @click="bakeSpline(index)">{{ tl('ef.constraint.spline_bake') }}</button></div><template v-if="item.type === 'armature_blend'"><div class="ef_constraint_armature_header"><b :title="tl('ef.constraint.armature_entries.desc')">{{ tl('ef.constraint.armature_entries') }}</b><button :title="tl('ef.constraint.armature_entries.desc')" @click="addArmatureEntry(index)">{{ tl('ef.constraint.add_armature_entry') }}</button></div><div class="ef_constraint_armature_entries"><div class="ef_constraint_armature_entry" v-for="(entry, entryIndex) in item.entries" :key="entry.id"><div class="ef_constraint_armature_entry_head"><b>{{ tl('ef.constraint.armature_entry') }} {{ entryIndex + 1 }}</b><span></span><button :title="tl('ef.constraint.move_up')" :disabled="entryIndex === 0" @click="moveArmatureEntry(index, entryIndex, -1)">↑</button><button :title="tl('ef.constraint.move_down')" :disabled="entryIndex === item.entries.length - 1" @click="moveArmatureEntry(index, entryIndex, 1)">↓</button><button :title="tl('ef.constraint.remove_armature_entry')" @click="removeArmatureEntry(index, entryIndex)">×</button></div><label :title="tl('ef.constraint.armature_entry.desc')">{{ tl('ef.constraint.target') }}<select :value="entry.target" @change="setArmatureTarget(index, entryIndex, $event.target.value)"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickArmatureTarget(index, entryIndex)">⌖</button></label><label :title="tl('ef.constraint.source_space.desc')">{{ tl('ef.constraint.source_space') }}<select :value="entry.source_space" @change="setArmatureSourceSpace(index, entryIndex, $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.armature_weight.desc')">{{ tl('ef.constraint.blend_weight') }}<input type="number" min="0" max="1" step="0.01" :value="entry.weight" @change="setArmatureWeight(index, entryIndex, $event.target.value)"><button :title="tl('ef.constraint.key_armature_weight')" @click="keyArmatureWeight(index, entryIndex)">◆</button></label><button :title="tl('ef.constraint.armature_offset.desc')" :disabled="!item.maintain_offset" @click="captureArmatureEntry(index, entryIndex)">{{ tl('ef.constraint.capture_armature_offset') }}</button></div></div><div class="ef_constraint_armature_options"><label :title="tl('ef.constraint.armature_target_space.desc')">{{ tl('ef.constraint.target_space') }}<select :value="item.target_space" @change="setArmatureField(index, 'target_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.normalize_weights.desc')"><input type="checkbox" :checked="item.normalize_weights !== false" @change="setArmatureField(index, 'normalize_weights', $event.target.checked)">{{ tl('ef.constraint.normalize_weights') }}</label></div><div class="ef_constraint_armature_channels" :title="tl('ef.constraint.armature_channels.desc')"><div v-for="channel in ['position','rotation','scale']"><label><input type="checkbox" :checked="item.channels[channel] !== false" @change="setArmatureChannel(index, channel, $event.target.checked)"><b>{{ tl('ef.constraint.' + channel) }}</b></label><label v-for="axis in ['x','y','z']"><input type="checkbox" :disabled="item.channels[channel] === false" :checked="item[channel + '_axes'][axis] !== false" @change="setArmatureAxis(index, channel, axis, $event.target.checked)">{{ axis.toUpperCase() }}</label></div></div><label :title="tl('ef.constraint.armature_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setArmatureOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.armature_offset.desc')" :disabled="!item.maintain_offset" @click="captureAllArmatureOffsets(index)">{{ tl('ef.constraint.capture_all_offsets') }}</button></label></template>
                        <template v-if="item.type === 'space_switch'"><div class="ef_constraint_space_header"><b :title="tl('ef.constraint.space_entries.desc')">{{ tl('ef.constraint.space_entries') }}</b><button :title="tl('ef.constraint.space_entries.desc')" @click="addSpaceEntry(index)">{{ tl('ef.constraint.add_space') }}</button></div><div class="ef_constraint_space_entries"><div class="ef_constraint_space_entry" v-for="(entry, entryIndex) in item.entries" :key="entry.id"><div class="ef_constraint_space_entry_head"><b>{{ tl('ef.constraint.space_entry') }} {{ entryIndex + 1 }}</b><span></span><button :title="tl('ef.constraint.move_up')" :disabled="entryIndex === 0" @click="moveSpaceEntry(index, entryIndex, -1)">↑</button><button :title="tl('ef.constraint.move_down')" :disabled="entryIndex === item.entries.length - 1" @click="moveSpaceEntry(index, entryIndex, 1)">↓</button><button :title="tl('ef.constraint.remove_space')" @click="removeSpaceEntry(index, entryIndex)">×</button></div><label :title="tl('ef.constraint.space_entry.desc')">{{ tl('ef.constraint.target') }}<select :value="entry.target" @change="setSpaceTarget(index, entryIndex, $event.target.value)"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickSpaceTarget(index, entryIndex)">⌖</button></label><label :title="tl('ef.constraint.key_space_weight')">{{ tl('ef.ik.influence') }}<input type="number" min="0" max="1" step="0.01" :value="entry.weight" @change="setSpaceWeight(index, entryIndex, $event.target.value)"><button :title="tl('ef.constraint.key_space_weight')" @click="keySpaceWeight(index, entryIndex)">◆</button></label><div class="ef_constraint_space_actions"><button :title="tl('ef.constraint.capture_space_offset.desc')" @click="captureSpaceEntry(index, entryIndex)">{{ tl('ef.constraint.capture_space_offset') }}</button><button :title="tl('ef.constraint.switch_to_space.desc')" @click="switchToSpace(index, entryIndex)">{{ tl('ef.constraint.switch_to_space') }}</button></div></div></div></template>
                        <template v-if="item.type === 'action_constraint'"><div class="ef_constraint_action_options"><label :title="tl('ef.constraint.target.desc')">{{ tl('ef.constraint.target') }}<select :value="item.target" @change="setActionTarget(index, $event.target.value)"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickActionTarget(index)">⌖</button></label><label :title="tl('ef.constraint.action.desc')">{{ tl('ef.constraint.action') }}<select :value="item.action_uuid" @change="setActionField(index, 'action_uuid', $event.target.value)"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="action in actionOptions(item)" :value="action.uuid">{{ action.name }}</option></select></label><label :title="tl('ef.constraint.driver_channel.desc')">{{ tl('ef.constraint.driver_channel') }}<select :value="item.driver_channel" @change="setActionField(index, 'driver_channel', $event.target.value)"><option v-for="channel in ['position','rotation','scale']" :value="channel">{{ tl('ef.constraint.' + channel) }}</option></select></label><label :title="tl('ef.constraint.driver_axis.desc')">{{ tl('ef.constraint.driver_axis') }}<select :value="item.driver_axis" @change="setActionField(index, 'driver_axis', $event.target.value)"><option v-for="axis in ['x','-x','y','-y','z','-z']" :value="axis">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.action_source_space.desc')">{{ tl('ef.constraint.source_space') }}<select :value="item.source_space" @change="setActionField(index, 'source_space', $event.target.value)"><option value="local">{{ tl('ef.constraint.local') }}</option><option value="world">{{ tl('ef.constraint.world') }}</option></select></label><label :title="tl('ef.constraint.input_range.desc')">{{ tl('ef.constraint.input_min') }}<input type="number" step="0.1" :value="item.input_min" @change="setActionNumber(index, 'input_min', $event.target.value)"></label><label :title="tl('ef.constraint.input_range.desc')">{{ tl('ef.constraint.input_max') }}<input type="number" step="0.1" :value="item.input_max" @change="setActionNumber(index, 'input_max', $event.target.value)"></label><label :title="tl('ef.constraint.action_range.desc')">{{ tl('ef.constraint.action_start') }}<input type="number" min="0" step="0.01" :value="item.action_start" @change="setActionNumber(index, 'action_start', $event.target.value)"></label><label :title="tl('ef.constraint.action_range.desc')">{{ tl('ef.constraint.action_end') }}<input type="number" min="0" step="0.01" :value="item.action_end" @change="setActionNumber(index, 'action_end', $event.target.value)"></label><label :title="tl('ef.constraint.mapping_mode.desc')">{{ tl('ef.constraint.mapping_mode') }}<select :value="item.mapping" @change="setActionField(index, 'mapping', $event.target.value)"><option v-for="mode in ['clamp','loop','pingpong']" :value="mode">{{ tl('ef.constraint.mapping_' + mode) }}</option></select></label><label :title="tl('ef.constraint.reverse.desc')"><input type="checkbox" :checked="item.reverse === true" @change="setActionField(index, 'reverse', $event.target.checked)">{{ tl('ef.constraint.reverse') }}</label></div><div class="ef_constraint_action_channels" :title="tl('ef.constraint.sample_channels.desc')"><div v-for="channel in ['position','rotation','scale']"><label><input type="checkbox" :checked="item.channels[channel] !== false" @change="setActionChannel(index, channel, $event.target.checked)"><b>{{ tl('ef.constraint.' + channel) }}</b></label><label v-for="axis in ['x','y','z']"><input type="checkbox" :disabled="item.channels[channel] === false" :checked="item[channel + '_axes'][axis] !== false" @change="setActionAxis(index, channel, axis, $event.target.checked)">{{ axis.toUpperCase() }}</label></div></div><label :title="tl('ef.constraint.action_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setActionOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.action_offset.desc')" :disabled="!item.maintain_offset" @click="resetActionOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <label v-if="item.type === 'copy_channels'" :title="tl('ef.constraint.space.desc')">{{ tl('ef.constraint.space') }}<select :value="item.space" @change="setCopySpace(index, $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label>
                        <label v-if="item.type === 'copy_channels'" :title="tl('ef.constraint.maintain_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setMaintainOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.reset_offset.desc')" :disabled="!item.maintain_offset" @click="resetCopyOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label>
                        <template v-if="item.type === 'copy_transform'"><div class="ef_constraint_copy_transform_options"><label :title="tl('ef.constraint.copy_transform_source_space.desc')">{{ tl('ef.constraint.source_space') }}<select :value="item.source_space" @change="setCopyTransformField(index, 'source_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.copy_transform_target_space.desc')">{{ tl('ef.constraint.target_space') }}<select :value="item.target_space" @change="setCopyTransformField(index, 'target_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.copy_transform_mix_mode.desc')">{{ tl('ef.constraint.mix_mode') }}<select :value="item.mix_mode" @change="setCopyTransformField(index, 'mix_mode', $event.target.value)"><option v-for="mode in ['replace','before','after']" :value="mode">{{ tl('ef.constraint.' + mode) }}</option></select></label></div><div class="ef_constraint_copy_transform_channels" :title="tl('ef.constraint.copy_transform_channels.desc')"><div v-for="channel in ['position','rotation','scale']"><label><input type="checkbox" :checked="!item.channels || item.channels[channel] !== false" @change="setCopyTransformChannel(index, channel, $event.target.checked)"><b>{{ tl('ef.constraint.' + channel) }}</b></label><label v-for="axis in ['x','y','z']"><input type="checkbox" :disabled="item.channels && item.channels[channel] === false" :checked="!item[channel + '_axes'] || item[channel + '_axes'][axis] !== false" @change="setCopyTransformAxis(index, channel, axis, $event.target.checked)">{{ axis.toUpperCase() }}</label></div></div><label :title="tl('ef.constraint.copy_transform_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setCopyTransformOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.copy_transform_offset.desc')" :disabled="!item.maintain_offset" @click="resetCopyTransformOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <template v-if="item.type === 'position_blend'"><div class="ef_constraint_position_blend_targets"><label :title="tl('ef.constraint.position_blend_target_a.desc')">{{ tl('ef.constraint.target_a') }}<select :value="item.target_a" @change="setTarget(index, $event.target.value, 'target_a')"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickTarget(index, 'target_a')">⌖</button></label><label :title="tl('ef.constraint.position_blend_target_b.desc')">{{ tl('ef.constraint.target_b') }}<select :value="item.target_b" @change="setTarget(index, $event.target.value, 'target_b')"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickTarget(index, 'target_b')">⌖</button></label></div><div class="ef_constraint_position_blend_options"><label :title="tl('ef.constraint.position_blend_source_space_a.desc')">{{ tl('ef.constraint.source_space_a') }}<select :value="item.source_space_a" @change="setPositionBlendField(index, 'source_space_a', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.position_blend_source_space_b.desc')">{{ tl('ef.constraint.source_space_b') }}<select :value="item.source_space_b" @change="setPositionBlendField(index, 'source_space_b', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.position_blend_target_space.desc')">{{ tl('ef.constraint.target_space') }}<select :value="item.target_space" @change="setPositionBlendField(index, 'target_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.position_blend_weight.desc')">{{ tl('ef.constraint.blend_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.blend_weight" @change="setPositionBlendField(index, 'blend_weight', $event.target.value)"></label></div><div class="ef_constraint_position_blend_flags"><label :title="tl('ef.constraint.invert_position_a.desc')"><input type="checkbox" :checked="item.invert_target_a === true" @change="setPositionBlendField(index, 'invert_target_a', $event.target.checked)">{{ tl('ef.constraint.invert_position_a') }}</label><label :title="tl('ef.constraint.invert_position_b.desc')"><input type="checkbox" :checked="item.invert_target_b === true" @change="setPositionBlendField(index, 'invert_target_b', $event.target.checked)">{{ tl('ef.constraint.invert_position_b') }}</label></div><div class="ef_constraint_position_blend_axes" :title="tl('ef.constraint.position_blend_axes.desc')"><b>{{ tl('ef.constraint.position_axes') }}</b><label v-for="axis in ['x','y','z']"><input type="checkbox" :checked="!item.position_axes || item.position_axes[axis] !== false" @change="setPositionBlendAxis(index, axis, $event.target.checked)">{{ axis.toUpperCase() }}</label></div><label :title="tl('ef.constraint.position_blend_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setPositionBlendOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.position_blend_offset.desc')" :disabled="!item.maintain_offset" @click="resetPositionBlendOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <template v-if="item.type === 'copy_quaternion'"><div class="ef_constraint_quaternion"><label :title="tl('ef.constraint.quaternion_source_space.desc')">{{ tl('ef.constraint.source_space') }}<select :value="item.source_space" @change="setQuaternionField(index, 'source_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.quaternion_target_space.desc')">{{ tl('ef.constraint.target_space') }}<select :value="item.target_space" @change="setQuaternionField(index, 'target_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.quaternion_mix_mode.desc')">{{ tl('ef.constraint.mix_mode') }}<select :value="item.mix_mode" @change="set(index, 'mix_mode', $event.target.value)"><option value="slerp">{{ tl('ef.constraint.shortest_slerp') }}</option><option value="nlerp">{{ tl('ef.constraint.normalized_nlerp') }}</option></select></label></div><label :title="tl('ef.constraint.invert_target.desc')"><input type="checkbox" :checked="item.invert_target === true" @change="setQuaternionField(index, 'invert_target', $event.target.checked)">{{ tl('ef.constraint.invert_target') }}</label><label :title="tl('ef.constraint.maintain_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setQuaternionOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.reset_offset.desc')" :disabled="!item.maintain_offset" @click="resetQuaternionOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <template v-if="item.type === 'rotation_blend'"><div class="ef_constraint_rotation_blend_targets"><label :title="tl('ef.constraint.target_a.desc')">{{ tl('ef.constraint.target_a') }}<select :value="item.target_a" @change="setTarget(index, $event.target.value, 'target_a')"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickTarget(index, 'target_a')">⌖</button></label><label :title="tl('ef.constraint.target_b.desc')">{{ tl('ef.constraint.target_b') }}<select :value="item.target_b" @change="setTarget(index, $event.target.value, 'target_b')"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickTarget(index, 'target_b')">⌖</button></label></div><div class="ef_constraint_rotation_blend_options"><label :title="tl('ef.constraint.source_space_a.desc')">{{ tl('ef.constraint.source_space_a') }}<select :value="item.source_space_a" @change="setRotationBlendField(index, 'source_space_a', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.source_space_b.desc')">{{ tl('ef.constraint.source_space_b') }}<select :value="item.source_space_b" @change="setRotationBlendField(index, 'source_space_b', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label v-if="item.type === 'rotation_blend'" :title="tl('ef.constraint.rotation_blend_target_space.desc')">{{ tl('ef.constraint.target_space') }}<select :value="item.target_space" @change="setRotationBlendField(index, 'target_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.rotation_blend_mix_mode.desc')">{{ tl('ef.constraint.mix_mode') }}<select :value="item.mix_mode" @change="setRotationBlendField(index, 'mix_mode', $event.target.value)"><option value="slerp">{{ tl('ef.constraint.shortest_slerp') }}</option><option value="nlerp">{{ tl('ef.constraint.normalized_nlerp') }}</option></select></label><label v-if="item.type === 'rotation_blend'" :title="tl('ef.constraint.blend_weight.desc')">{{ tl('ef.constraint.blend_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.blend_weight" @change="setRotationBlendField(index, 'blend_weight', Math.max(0, Math.min(1, Number($event.target.value))))"></label></div><div class="ef_constraint_rotation_blend_flags"><label :title="tl('ef.constraint.invert_target_a.desc')"><input type="checkbox" :checked="item.invert_target_a === true" @change="setRotationBlendField(index, 'invert_target_a', $event.target.checked)">{{ tl('ef.constraint.invert_target_a') }}</label><label :title="tl('ef.constraint.invert_target_b.desc')"><input type="checkbox" :checked="item.invert_target_b === true" @change="setRotationBlendField(index, 'invert_target_b', $event.target.checked)">{{ tl('ef.constraint.invert_target_b') }}</label></div><label v-if="item.type === 'rotation_blend'" :title="tl('ef.constraint.rotation_blend_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setRotationBlendOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.rotation_blend_offset.desc')" :disabled="!item.maintain_offset" @click="resetRotationBlendOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <template v-if="item.type === 'scale_blend'"><div class="ef_constraint_scale_blend_targets"><label :title="tl('ef.constraint.scale_blend_target_a.desc')">{{ tl('ef.constraint.target_a') }}<select :value="item.target_a" @change="setTarget(index, $event.target.value, 'target_a')"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickTarget(index, 'target_a')">⌖</button></label><label :title="tl('ef.constraint.scale_blend_target_b.desc')">{{ tl('ef.constraint.target_b') }}<select :value="item.target_b" @change="setTarget(index, $event.target.value, 'target_b')"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickTarget(index, 'target_b')">⌖</button></label></div><div class="ef_constraint_scale_blend_options"><label :title="tl('ef.constraint.scale_blend_source_space_a.desc')">{{ tl('ef.constraint.source_space_a') }}<select :value="item.source_space_a" @change="setScaleBlendField(index, 'source_space_a', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.scale_blend_source_space_b.desc')">{{ tl('ef.constraint.source_space_b') }}<select :value="item.source_space_b" @change="setScaleBlendField(index, 'source_space_b', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.scale_blend_target_space.desc')">{{ tl('ef.constraint.target_space') }}<select :value="item.target_space" @change="setScaleBlendField(index, 'target_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.scale_blend_weight.desc')">{{ tl('ef.constraint.blend_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.blend_weight" @change="setScaleBlendField(index, 'blend_weight', $event.target.value)"></label><label :title="tl('ef.constraint.scale_blend_mix_mode.desc')">{{ tl('ef.constraint.mix_mode') }}<select :value="item.mix_mode" @change="setScaleBlendField(index, 'mix_mode', $event.target.value)"><option value="linear">{{ tl('ef.constraint.linear') }}</option><option value="logarithmic">{{ tl('ef.constraint.logarithmic') }}</option></select></label></div><div class="ef_constraint_scale_blend_flags"><label :title="tl('ef.constraint.reciprocal_scale_a.desc')"><input type="checkbox" :checked="item.reciprocal_target_a === true" @change="setScaleBlendField(index, 'reciprocal_target_a', $event.target.checked)">{{ tl('ef.constraint.reciprocal_scale_a') }}</label><label :title="tl('ef.constraint.reciprocal_scale_b.desc')"><input type="checkbox" :checked="item.reciprocal_target_b === true" @change="setScaleBlendField(index, 'reciprocal_target_b', $event.target.checked)">{{ tl('ef.constraint.reciprocal_scale_b') }}</label></div><div class="ef_constraint_scale_blend_axes" :title="tl('ef.constraint.scale_blend_axes.desc')"><b>{{ tl('ef.constraint.scale_axes') }}</b><label v-for="axis in ['x','y','z']"><input type="checkbox" :checked="!item.scale_axes || item.scale_axes[axis] !== false" @change="setScaleBlendAxis(index, axis, $event.target.checked)">{{ axis.toUpperCase() }}</label></div><label :title="tl('ef.constraint.scale_blend_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setScaleBlendOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.scale_blend_offset.desc')" :disabled="!item.maintain_offset" @click="resetScaleBlendOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <template v-if="item.type === 'rotation_difference'"><div class="ef_constraint_rotation_blend_targets"><label :title="tl('ef.constraint.target_a.desc')">{{ tl('ef.constraint.target_a') }}<select :value="item.target_a" @change="setTarget(index, $event.target.value, 'target_a')"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickTarget(index, 'target_a')">⌖</button></label><label :title="tl('ef.constraint.target_b.desc')">{{ tl('ef.constraint.target_b') }}<select :value="item.target_b" @change="setTarget(index, $event.target.value, 'target_b')"><option value="">{{ tl('ef.ik.none') }}</option><option v-for="target in targets" :value="target.uuid">{{ target.name }}</option></select><button :title="tl('ef.constraint.pick_target')" @click="pickTarget(index, 'target_b')">⌖</button></label></div><div class="ef_constraint_rotation_blend_options"><label :title="tl('ef.constraint.source_space_a.desc')">{{ tl('ef.constraint.source_space_a') }}<select :value="item.source_space_a" @change="setRotationDifferenceField(index, 'source_space_a', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.source_space_b.desc')">{{ tl('ef.constraint.source_space_b') }}<select :value="item.source_space_b" @change="setRotationDifferenceField(index, 'source_space_b', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.rotation_difference_target_space.desc')">{{ tl('ef.constraint.target_space') }}<select :value="item.target_space" @change="setRotationDifferenceField(index, 'target_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="local">{{ tl('ef.constraint.local') }}</option></select></label><label :title="tl('ef.constraint.direction.desc')">{{ tl('ef.constraint.direction') }}<select :value="item.direction" @change="setRotationDifferenceField(index, 'direction', $event.target.value)"><option value="a_to_b">{{ tl('ef.constraint.a_to_b') }}</option><option value="b_to_a">{{ tl('ef.constraint.b_to_a') }}</option></select></label><label :title="tl('ef.constraint.application_mode.desc')">{{ tl('ef.constraint.application_mode') }}<select :value="item.application_mode" @change="setRotationDifferenceField(index, 'application_mode', $event.target.value)"><option value="replace">{{ tl('ef.constraint.replace') }}</option><option value="add">{{ tl('ef.constraint.add') }}</option></select></label><label :title="tl('ef.constraint.difference_strength.desc')">{{ tl('ef.constraint.difference_strength') }}<input type="number" min="0" max="1" step="0.01" :value="item.difference_strength" @change="setRotationDifferenceField(index, 'difference_strength', Math.max(0, Math.min(1, Number($event.target.value))))"></label></div><label :title="tl('ef.constraint.rotation_difference_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setRotationDifferenceOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.rotation_difference_offset.desc')" :disabled="!item.maintain_offset" @click="resetRotationDifferenceOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <template v-if="item.type === 'maintain_volume'"><div class="ef_constraint_maintain_volume"><label :title="tl('ef.constraint.maintain_volume_main_axis.desc')">{{ tl('ef.constraint.main_axis') }}<select :value="item.main_axis" @change="setMaintainVolumeAxis(index, $event.target.value)"><option v-for="axis in ['x','y','z']" :value="axis">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.reference_scale.desc')">{{ tl('ef.constraint.reference_scale') }}<input type="number" min="0" step="0.01" :value="item.reference_scale" disabled><button :title="tl('ef.constraint.reset_reference_scale.desc')" @click="resetMaintainVolumeReference(index)">{{ tl('ef.constraint.reset_reference_scale') }}</button></label><label :title="tl('ef.constraint.compensation_mode.desc')">{{ tl('ef.constraint.compensation_mode') }}<select :value="item.mode" @change="set(index, 'mode', $event.target.value)"><option v-for="mode in ['volume','area','uniform','custom']" :value="mode">{{ tl('ef.constraint.compensation_' + mode) }}</option></select></label><label :title="tl('ef.constraint.exponent.desc')">{{ tl('ef.constraint.exponent') }}<input type="number" min="0" max="2" step="0.1" :value="item.exponent" @change="setMaintainVolumeNumber(index, 'exponent', $event.target.value)"></label><label v-for="axis in ['x','y','z']" v-if="item.mode === 'custom'" :title="tl('ef.constraint.custom_weight.desc')">{{ tl('ef.constraint.custom_' + axis) }}<input type="number" min="0" max="1" step="0.05" :disabled="item.main_axis === axis" :value="item['custom_' + axis]" @change="setMaintainVolumeNumber(index, 'custom_' + axis, $event.target.value)"></label><label :title="tl('ef.constraint.min_factor.desc')">{{ tl('ef.constraint.min_factor') }}<input type="number" min="0" step="0.01" :value="item.min_factor" @change="setMaintainVolumeNumber(index, 'min_factor', $event.target.value)"></label><label :title="tl('ef.constraint.max_factor.desc')">{{ tl('ef.constraint.max_factor') }}<input type="number" min="0" step="0.01" :value="item.max_factor" @change="setMaintainVolumeNumber(index, 'max_factor', $event.target.value)"></label><label :title="tl('ef.constraint.compensation_weight.desc')">{{ tl('ef.constraint.compensation_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.compensation_weight" @change="setMaintainVolumeNumber(index, 'compensation_weight', $event.target.value)"></label></div></template>
                        <template v-if="item.type === 'stretch_to'"><div class="ef_constraint_stretch"><label :title="tl('ef.constraint.main_axis.desc')">{{ tl('ef.constraint.main_axis') }}<select :value="item.main_axis" @change="setStretchField(index, 'main_axis', $event.target.value)"><option v-for="axis in ['x','-x','y','-y','z','-z']" :value="axis" :disabled="item.up_axis === axis.replace('-', '')">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.up_axis.desc')">{{ tl('ef.constraint.up_axis') }}<select :value="item.up_axis" @change="setStretchField(index, 'up_axis', $event.target.value)"><option v-for="axis in ['x','y','z']" :value="axis" :disabled="item.main_axis.replace('-', '') === axis">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.original_length.desc')">{{ tl('ef.constraint.original_length') }}<input type="number" min="0" step="0.1" :value="item.original_length" disabled></label><label :title="tl('ef.constraint.rotation_weight.desc')">{{ tl('ef.constraint.rotation_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.rotation_weight" @change="setNumber(index, 'rotation_weight', $event.target.value)"></label><label :title="tl('ef.constraint.stretch_weight.desc')">{{ tl('ef.constraint.stretch_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.stretch_weight" @change="setNumber(index, 'stretch_weight', $event.target.value)"></label><label :title="tl('ef.constraint.min_stretch_ratio.desc')">{{ tl('ef.constraint.min_stretch_ratio') }}<input type="number" min="0" step="0.01" :value="item.min_stretch_ratio" @change="setStretchNumber(index, 'min_stretch_ratio', $event.target.value)"></label><label :title="tl('ef.constraint.max_stretch_ratio.desc')">{{ tl('ef.constraint.max_stretch_ratio') }}<input type="number" min="0" step="0.01" :value="item.max_stretch_ratio" @change="setStretchNumber(index, 'max_stretch_ratio', $event.target.value)"></label><label :title="tl('ef.constraint.volume_mode.desc')">{{ tl('ef.constraint.volume_mode') }}<select :value="item.volume_mode" @change="setStretchField(index, 'volume_mode', $event.target.value)"><option value="none">{{ tl('ef.constraint.volume_none') }}</option><option value="preserve">{{ tl('ef.constraint.volume_preserve') }}</option></select></label><label :title="tl('ef.constraint.volume_exponent.desc')">{{ tl('ef.constraint.volume_exponent') }}<input type="number" min="0" max="1" step="0.1" :value="item.volume_exponent" @change="setStretchNumber(index, 'volume_exponent', $event.target.value)"></label></div><label :title="tl('ef.constraint.maintain_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setStretchField(index, 'maintain_offset', $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.capture_stretch.desc')" @click="captureStretch(index)">{{ tl('ef.constraint.capture_stretch') }}</button></label></template>
                        <template v-if="['track_to', 'locked_track', 'damped_track'].includes(item.type)"><div class="ef_constraint_track"><label :title="tl('ef.constraint.track_axis.desc')">{{ tl('ef.constraint.track_axis') }}<select :value="item.track_axis" @change="setTrackField(index, 'track_axis', $event.target.value)"><option v-for="axis in ['x','-x','y','-y','z','-z']" :value="axis">{{ axis.toUpperCase() }}</option></select></label><label v-if="item.type === 'track_to'" :title="tl('ef.constraint.up_axis.desc')">{{ tl('ef.constraint.up_axis') }}<select :value="item.up_axis" @change="setTrackField(index, 'up_axis', $event.target.value)"><option v-for="axis in ['x','y','z']" :value="axis" :disabled="item.track_axis.replace('-', '') === axis">{{ axis.toUpperCase() }}</option></select></label><label v-if="item.type === 'locked_track'" :title="tl('ef.constraint.lock_axis.desc')">{{ tl('ef.constraint.lock_axis') }}<select :value="item.lock_axis" @change="setTrackField(index, 'lock_axis', $event.target.value)"><option v-for="axis in ['x','y','z']" :value="axis" :disabled="item.track_axis.replace('-', '') === axis">{{ axis.toUpperCase() }}</option></select></label><label v-if="item.type === 'track_to'" :title="tl('ef.constraint.up_space.desc')">{{ tl('ef.constraint.up_space') }}<select :value="item.up_space" @change="setTrackField(index, 'up_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world_up') }}</option><option value="target">{{ tl('ef.constraint.target_local_up') }}</option></select></label><label v-if="item.type === 'damped_track'" :title="tl('ef.constraint.damping_angle.desc')">{{ tl('ef.constraint.damping_angle') }}<input type="number" min="0" max="180" step="1" :value="item.damping_angle" @change="setTrackField(index, 'damping_angle', Math.max(0, Math.min(180, Number($event.target.value))))"></label></div><label :title="tl('ef.constraint.maintain_offset.desc')"><input type="checkbox" :checked="item.maintain_offset === true" @change="setTrackOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_offset') }}<button :title="tl('ef.constraint.reset_offset.desc')" :disabled="!item.maintain_offset" @click="resetTrackOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <template v-if="item.type === 'limit_distance'"><div class="ef_constraint_distance"><label :title="tl('ef.constraint.distance_mode.desc')">{{ tl('ef.constraint.distance_mode') }}<select :value="item.mode" @change="setDistanceMode(index, $event.target.value)"><option v-for="mode in ['exact','minimum','maximum','initial']" :value="mode">{{ tl('ef.constraint.distance_mode_' + mode) }}</option></select></label><label v-if="item.mode !== 'initial'" :title="tl('ef.constraint.distance_value.desc')">{{ tl('ef.constraint.distance_value') }}<input type="number" min="0" step="0.1" :value="item.distance" @change="setDistanceValue(index, 'distance', $event.target.value)"></label><label v-else :title="tl('ef.constraint.initial_distance.desc')">{{ tl('ef.constraint.initial_distance') }}<input type="number" min="0" step="0.1" :value="item.initial_distance" disabled><button :title="tl('ef.constraint.reset_initial_distance.desc')" @click="resetInitialDistance(index)">{{ tl('ef.constraint.reset_initial_distance') }}</button></label><label :title="tl('ef.constraint.softness.desc')">{{ tl('ef.constraint.softness') }}<input type="number" min="0" step="0.1" :value="item.softness" @change="setDistanceValue(index, 'softness', $event.target.value)"></label></div></template>
                        <template v-if="item.type === 'copy_channels'"><div class="ef_constraint_checks" v-for="channel in ['position', 'rotation', 'scale']" v-if="item.axes[channel]"><b>{{ tl('ef.constraint.' + channel) }}</b><label v-for="axis in ['x','y','z']"><input type="checkbox" :checked="item.axes[channel + '_axes'][axis]" @change="setCopyAxis(index, channel, axis, $event.target.checked)">{{ axis.toUpperCase() }}</label></div></template>
                        <template v-if="item.type === 'transform_mapping'">
                            <div class="ef_constraint_mapping_options"><label :title="tl('ef.constraint.source_channel.desc')">{{ tl('ef.constraint.source_channel') }}<select :value="item.source_channel" @change="set(index, 'source_channel', $event.target.value)"><option v-for="channel in ['position','rotation','scale']" :value="channel">{{ tl('ef.constraint.' + channel) }}</option></select></label><label :title="tl('ef.constraint.target_channel.desc')">{{ tl('ef.constraint.target_channel') }}<select :value="item.target_channel" @change="set(index, 'target_channel', $event.target.value)"><option v-for="channel in ['position','rotation','scale']" :value="channel">{{ tl('ef.constraint.' + channel) }}</option></select></label><label :title="tl('ef.constraint.source_space.desc')">{{ tl('ef.constraint.source_space') }}<select :value="item.source_space" @change="set(index, 'source_space', $event.target.value)"><option value="local">{{ tl('ef.constraint.local') }}</option><option value="world">{{ tl('ef.constraint.world') }}</option></select></label><label :title="tl('ef.constraint.target_space.desc')">{{ tl('ef.constraint.target_space') }}<select :value="item.target_space" @change="set(index, 'target_space', $event.target.value)"><option value="local">{{ tl('ef.constraint.local') }}</option><option value="world">{{ tl('ef.constraint.world') }}</option></select></label><label :title="tl('ef.constraint.mix_mode.desc')">{{ tl('ef.constraint.mix_mode') }}<select :value="item.mix_mode" @change="set(index, 'mix_mode', $event.target.value)"><option v-for="mode in ['replace','add','multiply']" :value="mode">{{ tl('ef.constraint.' + mode) }}</option></select></label><label :title="item.extrapolate ? tl('ef.constraint.extrapolate.desc') : tl('ef.constraint.clamp.desc')"><input type="checkbox" :checked="item.extrapolate === true" @change="set(index, 'extrapolate', $event.target.checked)">{{ item.extrapolate ? tl('ef.constraint.extrapolate') : tl('ef.constraint.clamp') }}</label></div>
                            <div class="ef_constraint_mapping"><b>{{ tl('ef.constraint.axis_mapping') }}</b><div class="ef_constraint_mapping_head"><span></span><span :title="tl('ef.constraint.axis_mapping.desc')">{{ tl('ef.constraint.axis_mapping') }}</span><span :title="tl('ef.constraint.from_min.desc')">{{ tl('ef.constraint.from_min') }}</span><span :title="tl('ef.constraint.from_max.desc')">{{ tl('ef.constraint.from_max') }}</span><span :title="tl('ef.constraint.to_min.desc')">{{ tl('ef.constraint.to_min') }}</span><span :title="tl('ef.constraint.to_max.desc')">{{ tl('ef.constraint.to_max') }}</span></div><div v-for="axis in [0,1,2]"><b>{{ ['X','Y','Z'][axis] }}</b><select :value="item.axis_mapping[axis]" @change="setMappingAxis(index, axis, $event.target.value)"><option v-for="sourceAxis in [0,1,2]" :value="sourceAxis">{{ ['X','Y','Z'][sourceAxis] }}</option></select><input type="number" :value="item.from_min[axis]" @change="setVector(index, 'from_min', axis, $event.target.value)"><input type="number" :value="item.from_max[axis]" @change="setVector(index, 'from_max', axis, $event.target.value)"><input type="number" :value="item.to_min[axis]" @change="setVector(index, 'to_min', axis, $event.target.value)"><input type="number" :value="item.to_max[axis]" @change="setVector(index, 'to_max', axis, $event.target.value)"></div></div>
                        </template>
                        <template v-if="item.type === 'shrinkwrap'"><div class="ef_constraint_shrinkwrap"><label :title="tl('ef.constraint.shrinkwrap_mode.desc')">{{ tl('ef.constraint.shrinkwrap_mode') }}<select :value="item.mode" @change="setShrinkwrapField(index, 'mode', $event.target.value)"><option value="nearest_surface">{{ tl('ef.constraint.shrinkwrap_nearest') }}</option><option value="project">{{ tl('ef.constraint.shrinkwrap_project') }}</option></select></label><label v-if="item.mode === 'project'" :title="tl('ef.constraint.project_axis.desc')">{{ tl('ef.constraint.project_axis') }}<select :value="item.project_axis" @change="setShrinkwrapField(index, 'project_axis', $event.target.value)"><option v-for="axis in ['x','-x','y','-y','z','-z']" :value="axis">{{ axis.toUpperCase() }}</option></select></label><label v-if="item.mode === 'project'" :title="tl('ef.constraint.direction_space.desc')">{{ tl('ef.constraint.direction_space') }}<select :value="item.direction_space" @change="setShrinkwrapField(index, 'direction_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="target">{{ tl('ef.constraint.target_local') }}</option></select></label><label v-if="item.mode === 'project'" :title="tl('ef.constraint.bidirectional.desc')"><input type="checkbox" :checked="item.bidirectional === true" @change="setShrinkwrapField(index, 'bidirectional', $event.target.checked)">{{ tl('ef.constraint.bidirectional') }}</label><label :title="tl('ef.constraint.surface_offset.desc')">{{ tl('ef.constraint.surface_offset') }}<input type="number" step="0.1" :value="item.surface_offset" @change="setShrinkwrapNumber(index, 'surface_offset', $event.target.value)"></label><label :title="tl('ef.constraint.max_distance.desc')">{{ tl('ef.constraint.max_distance') }}<input type="number" min="0" step="0.1" :value="item.max_distance" @change="setShrinkwrapNumber(index, 'max_distance', $event.target.value)"></label><label v-if="item.type === 'follow_path'" :title="tl('ef.constraint.position_weight.desc')">{{ tl('ef.constraint.position_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.position_weight" @change="setShrinkwrapNumber(index, 'position_weight', $event.target.value)"></label></div><label :title="tl('ef.constraint.flip_normal.desc')"><input type="checkbox" :checked="item.flip_normal === true" @change="setShrinkwrapField(index, 'flip_normal', $event.target.checked)">{{ tl('ef.constraint.flip_normal') }}</label><label :title="tl('ef.constraint.align_rotation.desc')"><input type="checkbox" :checked="item.align_rotation === true" @change="setShrinkwrapField(index, 'align_rotation', $event.target.checked)">{{ tl('ef.constraint.align_rotation') }}</label><div class="ef_constraint_shrinkwrap_rotation" v-if="item.align_rotation === true"><label :title="tl('ef.constraint.shrinkwrap_up_axis.desc')">{{ tl('ef.constraint.up_axis') }}<select :value="item.up_axis" @change="setShrinkwrapField(index, 'up_axis', $event.target.value)"><option v-for="axis in ['x','y','z']" :value="axis">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.shrinkwrap_rotation_weight.desc')">{{ tl('ef.constraint.rotation_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.rotation_weight" @change="setShrinkwrapNumber(index, 'rotation_weight', $event.target.value)"></label></div><label v-if="item.align_rotation === true" :title="tl('ef.constraint.shrinkwrap_rotation_offset.desc')"><input type="checkbox" :checked="item.maintain_rotation_offset === true" @change="setShrinkwrapRotationOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_rotation_offset') }}<button :title="tl('ef.constraint.shrinkwrap_rotation_offset.desc')" :disabled="!item.maintain_rotation_offset" @click="resetShrinkwrapRotationOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <template v-if="item.type === 'floor_drop'"><div class="ef_constraint_floor_drop"><label :title="tl('ef.constraint.drop_axis.desc')">{{ tl('ef.constraint.drop_axis') }}<select :value="item.drop_axis" @change="setFloorDropField(index, 'drop_axis', $event.target.value)"><option v-for="axis in ['x','-x','y','-y','z','-z']" :value="axis">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.direction_space.desc')">{{ tl('ef.constraint.direction_space') }}<select :value="item.direction_space" @change="setFloorDropField(index, 'direction_space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="target">{{ tl('ef.constraint.target_local') }}</option></select></label><label :title="tl('ef.constraint.floor_drop_mode.desc')">{{ tl('ef.constraint.floor_drop_mode') }}<select :value="item.mode" @change="setFloorDropField(index, 'mode', $event.target.value)"><option value="snap">{{ tl('ef.constraint.floor_drop_mode_snap') }}</option><option value="above_only">{{ tl('ef.constraint.floor_drop_mode_above_only') }}</option></select></label><label :title="tl('ef.constraint.surface_offset.desc')">{{ tl('ef.constraint.surface_offset') }}<input type="number" step="0.1" :value="item.surface_offset" @change="setFloorDropNumber(index, 'surface_offset', $event.target.value)"></label><label :title="tl('ef.constraint.max_distance.desc')">{{ tl('ef.constraint.max_distance') }}<input type="number" min="0" step="0.1" :value="item.max_distance" @change="setFloorDropNumber(index, 'max_distance', $event.target.value)"></label><label v-if="item.type === 'follow_path'" :title="tl('ef.constraint.position_weight.desc')">{{ tl('ef.constraint.position_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.position_weight" @change="setFloorDropNumber(index, 'position_weight', $event.target.value)"></label></div><label :title="tl('ef.constraint.align_rotation.desc')"><input type="checkbox" :checked="item.align_rotation === true" @change="setFloorDropField(index, 'align_rotation', $event.target.checked)">{{ tl('ef.constraint.align_rotation') }}</label><div class="ef_constraint_floor_drop_rotation" v-if="item.align_rotation === true"><label :title="tl('ef.constraint.floor_drop_up_axis.desc')">{{ tl('ef.constraint.up_axis') }}<select :value="item.up_axis" @change="setFloorDropField(index, 'up_axis', $event.target.value)"><option v-for="axis in ['x','y','z']" :value="axis">{{ axis.toUpperCase() }}</option></select></label><label :title="tl('ef.constraint.floor_drop_rotation_weight.desc')">{{ tl('ef.constraint.rotation_weight') }}<input type="number" min="0" max="1" step="0.01" :value="item.rotation_weight" @change="setFloorDropNumber(index, 'rotation_weight', $event.target.value)"></label></div><label v-if="item.align_rotation === true" :title="tl('ef.constraint.floor_drop_rotation_offset.desc')"><input type="checkbox" :checked="item.maintain_rotation_offset === true" @change="setFloorDropRotationOffset(index, $event.target.checked)">{{ tl('ef.constraint.maintain_rotation_offset') }}<button :title="tl('ef.constraint.floor_drop_rotation_offset.desc')" :disabled="!item.maintain_rotation_offset" @click="resetFloorDropRotationOffset(index)">{{ tl('ef.constraint.reset_offset') }}</button></label></template>
                        <template v-if="item.type === 'floor' || item.type === 'pivot'">
                            <label :title="tl('ef.constraint.axis.desc')">{{ tl('ef.constraint.axis') }}<select :value="item.axis" @change="set(index, 'axis', $event.target.value)"><option v-for="axis in ['x','-x','y','-y','z','-z']" :value="axis">{{ axis.toUpperCase() }}</option></select></label>
                            <label :title="tl('ef.constraint.space.desc')">{{ tl('ef.constraint.space') }}<select :value="item.space" @change="set(index, 'space', $event.target.value)"><option value="world">{{ tl('ef.constraint.world') }}</option><option value="target">{{ tl('ef.constraint.target_local') }}</option></select></label>
                        </template>
                        <template v-if="item.type === 'floor'"><label :title="tl('ef.constraint.offset.desc')">{{ tl('ef.constraint.offset') }}<input type="number" step="0.1" :value="item.offset" @change="set(index, 'offset', Number($event.target.value))"></label><label :title="tl('ef.constraint.prevent_penetration.desc')"><input type="checkbox" :checked="item.prevent_penetration !== false" @change="set(index, 'prevent_penetration', $event.target.checked)">{{ item.prevent_penetration !== false ? tl('ef.constraint.prevent_penetration') : tl('ef.constraint.snap_to_plane') }}</label></template>
                        <template v-if="item.type === 'pivot'"><label :title="tl('ef.constraint.angle.desc')">{{ tl('ef.constraint.angle') }}<input type="number" step="1" :value="item.angle" @change="set(index, 'angle', Number($event.target.value))"></label><label :title="tl('ef.constraint.keep_radius.desc')"><input type="checkbox" :checked="item.keep_radius !== false" @change="set(index, 'keep_radius', $event.target.checked)">{{ tl('ef.constraint.keep_radius') }}</label><label :title="tl('ef.constraint.follow_rotation.desc')"><input type="checkbox" :checked="item.follow_rotation === true" @change="set(index, 'follow_rotation', $event.target.checked)">{{ tl('ef.constraint.follow_rotation') }}</label></template>
                        <template v-if="item.type === 'limit_transform'"><div class="ef_constraint_limit" v-for="channel in ['position', 'rotation', 'scale']" v-if="!item.limit_channel || item.limit_channel === channel"><b>{{ tl('ef.constraint.' + channel) }}</b><div v-for="axis in [0,1,2]"><input type="checkbox" :checked="item[channel + '_axes'][axis]" @change="setAxis(index, channel + '_axes', axis, $event.target.checked)"><span>{{ ['X','Y','Z'][axis] }}</span><input type="number" :value="item[channel + '_min'][axis]" @change="setVector(index, channel + '_min', axis, $event.target.value)"><input type="number" :value="item[channel + '_max'][axis]" @change="setVector(index, channel + '_max', axis, $event.target.value)"></div></div></template>
                        <button v-if="item.type === 'child_of'" :title="tl('ef.constraint.set_inverse.desc')" @click="setInverse(index)">{{ tl('ef.constraint.set_inverse') }}</button>
                    </div>
                </div>
                <div class="ef_constraint_bake"><button :title="tl('ef.constraint.bake_selected.desc')" @click="bakeSelected(false)">{{ tl('ef.constraint.bake_selected') }}</button><button :title="tl('ef.constraint.bake_clear.desc')" @click="bakeSelected(true)">{{ tl('ef.constraint.bake_clear') }}</button><button :title="tl('ef.constraint.bake_all.desc')" @click="bakeAll(true)">{{ tl('ef.constraint.bake_all') }}</button></div>
            </template>
        </div>`
    };
    panel = new Panel('ef_constraints', {
        name: 'ef.constraint.panel',
        icon: 'link',
        condition: () => Modes.animate,
        growable: true,
        resizable: true,
        default_position: {slot: 'left_bar', height: 420, sidebar_index: 100},
        component: panelComponent
    });
    const css = Blockbench.addCSS(`.ef_constraint_panel{padding:8px;display:flex;flex-direction:column;gap:8px;overflow:auto;height:100%;box-sizing:border-box}.ef_constraint_owner{font-weight:700;padding:5px 0}.ef_constraint_add,.ef_constraint_bake{display:grid;gap:6px}.ef_constraint_add details{border:1px solid var(--color-border);background:var(--color-back);border-radius:3px;padding:4px}.ef_constraint_add summary{cursor:pointer;font-weight:700;padding:4px;user-select:none}.ef_constraint_group{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;padding-top:4px}.ef_constraint_add button,.ef_constraint_bake button{height:auto;min-height:44px;padding:6px 8px;line-height:1.25;white-space:normal;overflow-wrap:anywhere}.ef_constraint_stack{display:flex;flex-direction:column;gap:6px}.ef_constraint_card{border:1px solid var(--color-border);background:var(--color-back);padding:6px;display:flex;flex-direction:column;gap:5px}.ef_constraint_head{display:flex;align-items:center;gap:4px}.ef_constraint_head span{flex:1}.ef_constraint_head button{min-width:24px}.ef_constraint_card label{display:flex;align-items:center;gap:5px}.ef_constraint_card label select,.ef_constraint_card label input[type=number]{flex:1;min-width:0}.ef_constraint_checks{display:flex;gap:12px;align-items:center}.ef_constraint_limit{display:grid;gap:3px}.ef_constraint_limit>div{display:grid;grid-template-columns:18px 18px 1fr 1fr;gap:3px}.ef_constraint_limit input{min-width:0;width:100%}.ef_constraint_mapping_options,.ef_constraint_action_options,.ef_constraint_track,.ef_constraint_stretch,.ef_constraint_maintain_volume,.ef_constraint_distance,.ef_constraint_floor_drop,.ef_constraint_floor_drop_rotation,.ef_constraint_shrinkwrap,.ef_constraint_shrinkwrap_rotation,.ef_constraint_quaternion,.ef_constraint_copy_transform_options,.ef_constraint_position_blend_targets,.ef_constraint_position_blend_options,.ef_constraint_rotation_blend_targets,.ef_constraint_rotation_blend_options,.ef_constraint_scale_blend_targets,.ef_constraint_scale_blend_options{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:5px}.ef_constraint_copy_transform_channels,.ef_constraint_action_channels{display:grid;gap:5px}.ef_constraint_copy_transform_channels>div,.ef_constraint_action_channels>div{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px}.ef_constraint_copy_transform_channels>div>label:first-child,.ef_constraint_action_channels>div>label:first-child{flex:1 1 120px}.ef_constraint_position_blend_flags,.ef_constraint_position_blend_axes,.ef_constraint_rotation_blend_flags,.ef_constraint_scale_blend_flags,.ef_constraint_scale_blend_axes{display:flex;flex-wrap:wrap;gap:8px 16px}.ef_constraint_position_blend_flags label,.ef_constraint_rotation_blend_flags label,.ef_constraint_scale_blend_flags label{flex:1 1 150px}.ef_constraint_position_blend_axes b,.ef_constraint_scale_blend_axes b{margin-right:auto}.ef_constraint_position_blend_axes label,.ef_constraint_scale_blend_axes label{flex:0 0 auto}.ef_constraint_armature_header,.ef_constraint_armature_entry_head,.ef_constraint_space_header,.ef_constraint_space_entry_head,.ef_constraint_path_header,.ef_constraint_path_point_head{display:flex;align-items:center;gap:5px}.ef_constraint_armature_header b,.ef_constraint_armature_entry_head span,.ef_constraint_space_header b,.ef_constraint_space_entry_head span,.ef_constraint_path_header b,.ef_constraint_path_point_head span{flex:1}.ef_constraint_armature_entries,.ef_constraint_space_entries,.ef_constraint_path_points{display:grid;gap:6px}.ef_constraint_path_point{display:grid;gap:5px;padding:6px;border:1px solid var(--color-border);background:var(--color-ui)}.ef_constraint_path_options,.ef_constraint_path_rotation{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:5px}.ef_constraint_path_offset{display:grid;grid-template-columns:auto repeat(3,minmax(70px,1fr));gap:6px;align-items:center}.ef_constraint_path_offset label{min-width:0}.ef_constraint_path_warning{padding:5px;color:var(--color-accent);border:1px solid var(--color-accent);overflow-wrap:anywhere}.ef_constraint_armature_entry,.ef_constraint_space_entry{display:grid;gap:5px;padding:6px;border:1px solid var(--color-border);background:var(--color-ui)}.ef_constraint_armature_options{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:5px}.ef_constraint_armature_channels{display:grid;gap:5px}.ef_constraint_armature_channels>div{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px}.ef_constraint_armature_channels>div>label:first-child{flex:1 1 120px}.ef_constraint_space_actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:5px}.ef_constraint_space_actions button{height:auto;white-space:normal}.ef_constraint_mapping{display:grid;gap:4px;overflow-x:auto}.ef_constraint_mapping>div{display:grid;grid-template-columns:24px minmax(60px,.7fr) repeat(4,minmax(76px,1fr));gap:4px;align-items:center;min-width:430px}.ef_constraint_mapping input,.ef_constraint_mapping select{min-width:0;width:100%}.ef_constraint_mapping_head{font-size:11px;opacity:.8;text-align:center}.ef_constraint_empty{opacity:.7;padding:12px;text-align:center}@media(max-width:520px){.ef_constraint_mapping_options,.ef_constraint_action_options,.ef_constraint_track,.ef_constraint_stretch,.ef_constraint_maintain_volume,.ef_constraint_distance,.ef_constraint_floor_drop,.ef_constraint_floor_drop_rotation,.ef_constraint_shrinkwrap,.ef_constraint_shrinkwrap_rotation,.ef_constraint_quaternion,.ef_constraint_copy_transform_options,.ef_constraint_position_blend_targets,.ef_constraint_position_blend_options,.ef_constraint_rotation_blend_targets,.ef_constraint_rotation_blend_options,.ef_constraint_scale_blend_targets,.ef_constraint_scale_blend_options,.ef_constraint_armature_options,.ef_constraint_path_options,.ef_constraint_path_rotation{grid-template-columns:1fr}.ef_constraint_path_offset{grid-template-columns:1fr}.ef_constraint_mapping>div{grid-template-columns:22px 55px repeat(4,72px)}}`);
    const refreshHandler = () => refresh();
    function refresh() {
        const animation = typeof Animation !== 'undefined' && Animation.selected;
        ArmatureBone.all.forEach(bone => {
            const animator = animation && animation.animators && animation.animators[bone.uuid];
            getStack(bone).forEach(constraint => {
                ensureInfluenceChannel(animator, constraint);
                if (constraint.type === 'follow_path') ensurePathProgressChannel(animator, constraint);
                if (constraint.type === 'armature_blend' && Array.isArray(constraint.entries)) constraint.entries.forEach(entry => ensureArmatureWeightChannel(animator, constraint, entry));
                if (constraint.type === 'space_switch' && Array.isArray(constraint.entries)) constraint.entries.forEach(entry => ensureSpaceWeightChannel(animator, constraint, entry));
            });
        });
        if (!panel || !panel.vue) return;
        const bone = selectedBone();
        panel.vue.bone = bone || null;
        panel.vue.stack = bone ? cloneValue(getStack(bone)) : [];
        panel.vue.targets = allConstraintTargets().filter(item => item !== bone && item.mesh);
        panel.vue.version++;
    }
    Blockbench.on('update_selection', refreshHandler);
    Blockbench.on('select_project', refreshHandler);
    Blockbench.on('update_keyframe_selection', refreshHandler);
    refresh();
    return {
        cleanup() {
            if (Animator.preview === previewWithConstraints) Animator.preview = originalPreview;
            if (originalConstraintRaycast && Preview.prototype.raycast !== originalConstraintRaycast) Preview.prototype.raycast = originalConstraintRaycast;
            if (animatorPrototype && animatorPrototype.channels !== originalChannels) animatorPrototype.channels = originalChannels;
            pickingTarget = null;
            Blockbench.removeListener('update_selection', refreshHandler);
            Blockbench.removeListener('select_project', refreshHandler);
            Blockbench.removeListener('update_keyframe_selection', refreshHandler);
            if (panel) panel.delete();
            if (css && typeof css.delete === 'function') css.delete();
            properties.forEach(property => property.delete());
        }
    };
}

// ============================================================
//  Plugin Registration
// ============================================================

let efIKCleanup = null;
let efConstraintCleanup = null;

Plugin.register('epicfight_export', {
    title: 'EpicFight Tools',
    author: 'zi_dou',
    description: 'Import EpicFight JSON assets and export to EpicFight JSON format',
    icon: 'gamepad',
    version: '0.4.0',
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
        efConstraintCleanup = efSetupConstraintSupport();
    },

    onunload() {
        ['ef_import_mesh', 'ef_import_armature', 'ef_import_animation', 'ef_export_model', 'ef_export_animation', 'ef_export_animation_batch', 'ef_export_entity'].forEach(function(id) {
            const action = Action.actions[id];
            if (action) action.delete();
        });
        if (efConstraintCleanup) {
            efConstraintCleanup.cleanup();
            efConstraintCleanup = null;
        }
        if (efIKCleanup) {
            efIKCleanup.cleanup();
            efIKCleanup = null;
        }
    }
});
